// Controlled NOVUS OUTBOUND -> Instantly handoff.
//
// OUTBOUND remains the source of truth. Dry-run is read-only. The protected
// single-lead path remains available for controlled checks; production bulk
// processing uses the same mapper, eligibility rules and per-row marker
// writes. Neither path changes outbound_status: uploading a lead is not the
// same as sending an email.

export const INSTANTLY_CREATE_LEAD_URL = 'https://api.instantly.ai/api/v2/leads';
export const INSTANTLY_LIVE_CONFIRMATION = 'UPLOAD_ONE_TO_INSTANTLY';
export const INSTANTLY_BULK_CONFIRMATION = 'UPLOAD_ALL_ELIGIBLE_TO_INSTANTLY';

export const INSTANTLY_OUTBOUND_REQUIRED_HEADERS = [
  'outbound_id',
  'outreach_contact_email',
  'first_name',
  'clean_agency_name',
  'property_street',
  'probe_date',
  'probe_time',
  'email_observation',
  'email_commercial_hook',
  'email_commercial_hook_email_2',
  'demo_url',
  'outbound_status',
  'instantly_lead_id',
  'instantly_added_at',
  'last_error',
  'updated_at',
];

function nonblank(value) {
  return String(value ?? '').trim().length > 0;
}

function validTestEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function rowObject(header, row) {
  return Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']));
}

function assertRequiredHeaders(header) {
  const missing = INSTANTLY_OUTBOUND_REQUIRED_HEADERS.filter((column) => !header.includes(column));
  if (missing.length) throw new Error(`OUTBOUND is missing required column(s): ${missing.join(', ')}`);
}

function recordsFromTable(table) {
  assertRequiredHeaders(table?.header || []);
  const idIndex = table.header.indexOf('outbound_id');
  return table.rows.flatMap((row, index) => {
    const outboundId = row[idIndex] ?? '';
    if (!outboundId || outboundId === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: rowObject(table.header, row) }];
  });
}

export function outboundEligibilityReasons(row) {
  const reasons = [];
  if (row.outbound_status !== 'READY') {
    reasons.push(`outbound_status_not_READY:${row.outbound_status || '(blank)'}`);
  }
  if (nonblank(row.instantly_lead_id)) reasons.push('instantly_lead_id_nonblank');
  if (nonblank(row.instantly_added_at)) reasons.push('instantly_added_at_nonblank');
  return reasons;
}

export function mapOutboundToInstantly(row, campaignId, { testEmail } = {}) {
  if (!nonblank(campaignId)) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  if (testEmail !== undefined && !validTestEmail(testEmail)) {
    throw new Error('test_email must be a valid email address');
  }
  return {
    campaign: campaignId,
    email: testEmail === undefined ? row.outreach_contact_email : testEmail,
    first_name: row.first_name,
    company_name: row.clean_agency_name,
    custom_variables: {
      property_street: row.property_street,
      probe_date: row.probe_date,
      probe_time: row.probe_time,
      email_observation: row.email_observation,
      email_commercial_hook: row.email_commercial_hook,
      email_commercial_hook_email_2: row.email_commercial_hook_email_2,
      demo_url: row.demo_url,
    },
    skip_if_in_workspace: true,
    skip_if_in_campaign: true,
  };
}

export async function buildInstantlyDryRun(repo, {
  campaignId,
  sampleLimit = 3,
} = {}) {
  if (!nonblank(campaignId)) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  const table = await repo.getTable('OUTBOUND');
  // Stable operator output: samples and skip rows are ordered by the durable
  // queue identity, never by incidental Sheet row position.
  const records = recordsFromTable(table).sort((a, b) => a.obj.outbound_id.localeCompare(b.obj.outbound_id));
  const eligible = [];
  const skipped = [];
  const skipReasons = {};

  for (const record of records) {
    const reasons = outboundEligibilityReasons(record.obj);
    if (reasons.length) {
      skipped.push({ outbound_id: record.obj.outbound_id, reasons });
      for (const reason of reasons) skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      continue;
    }
    eligible.push({
      outbound_id: record.obj.outbound_id,
      payload: mapOutboundToInstantly(record.obj, campaignId),
    });
  }

  const boundedLimit = Math.max(0, Math.min(20, Number.isFinite(Number(sampleLimit)) ? Math.floor(Number(sampleLimit)) : 3));
  return {
    dry_run: true,
    total_rows: records.length,
    eligible_rows: eligible.length,
    skipped_rows: skipped.length,
    skip_reasons: skipReasons,
    skipped,
    sample_limit: boundedLimit,
    sample_payloads: eligible.slice(0, boundedLimit),
  };
}

function failureMessage(status, body) {
  const detail = body && typeof body === 'object'
    ? (body.error || body.message || JSON.stringify(body))
    : String(body || '');
  const suffix = detail ? `: ${detail}` : '';
  return `Instantly create lead failed${status ? ` (HTTP ${status})` : ''}${suffix}`.slice(0, 1000);
}

async function readResponse(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { message: text }; }
}

async function writeExecutionFields(repo, table, record, patch) {
  const writes = Object.entries(patch).map(([column, value]) => ({
    tab: 'OUTBOUND',
    rowNumber: record.rowNumber,
    columnNumber: table.header.indexOf(column) + 1,
    value,
  }));
  await repo.writeCellsBatch(writes);
}

async function uploadRecord(repo, table, record, {
  apiKey,
  campaignId,
  fetchImpl,
  now,
  testEmail,
} = {}) {
  const testMode = testEmail !== undefined;
  const payload = mapOutboundToInstantly(record.obj, campaignId, testMode ? { testEmail } : {});
  let response;
  let body;
  try {
    response = await fetchImpl(INSTANTLY_CREATE_LEAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    body = await readResponse(response);
  } catch (err) {
    const message = failureMessage(0, err?.message || String(err));
    if (!testMode) {
      const timestamp = now();
      await writeExecutionFields(repo, table, record, { last_error: message, updated_at: timestamp });
    }
    throw new Error(message);
  }

  const leadId = body?.id;
  if (!response.ok || !nonblank(leadId)) {
    const message = !response.ok
      ? failureMessage(response.status, body)
      : 'Instantly create lead failed: response did not include a nonblank lead ID';
    if (!testMode) {
      const timestamp = now();
      await writeExecutionFields(repo, table, record, { last_error: message, updated_at: timestamp });
    }
    throw new Error(message);
  }

  if (testMode) {
    return { leadId, payload, timestamp: null };
  }

  const timestamp = now();
  await writeExecutionFields(repo, table, record, {
    instantly_lead_id: leadId,
    instantly_added_at: timestamp,
    last_error: '',
    updated_at: timestamp,
  });
  return { leadId, payload, timestamp };
}

export async function uploadSingleOutboundLead(repo, {
  outboundId,
  confirmation,
  testEmail,
  apiKey,
  campaignId,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof outboundId !== 'string' || !nonblank(outboundId)) {
    throw new Error('Live mode requires one exact outbound_id');
  }
  if (confirmation !== INSTANTLY_LIVE_CONFIRMATION) {
    throw new Error(`Live mode requires confirmation=${INSTANTLY_LIVE_CONFIRMATION}`);
  }
  if (!nonblank(apiKey)) throw new Error('INSTANTLY_API_KEY is not set');
  if (!nonblank(campaignId)) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  if (typeof fetchImpl !== 'function') throw new Error('Instantly fetch transport is unavailable');

  // This is the final read before the one permitted API request. Duplicate
  // outbound_ids fail closed rather than allowing an ambiguous selection.
  const table = await repo.getTable('OUTBOUND');
  const matches = recordsFromTable(table).filter((record) => record.obj.outbound_id === outboundId);
  if (matches.length !== 1) {
    throw new Error(matches.length ? `OUTBOUND contains duplicate outbound_id ${outboundId}` : `OUTBOUND row ${outboundId} not found`);
  }
  const record = matches[0];
  const reasons = outboundEligibilityReasons(record.obj);
  if (reasons.length) throw new Error(`OUTBOUND row ${outboundId} is not eligible: ${reasons.join(', ')}`);

  const testMode = testEmail !== undefined;
  const uploaded = await uploadRecord(repo, table, record, {
    apiKey,
    campaignId,
    fetchImpl,
    now,
    ...(testMode ? { testEmail } : {}),
  });

  if (testMode) {
    return {
      ok: true,
      test_mode: true,
      message: 'TEST MODE: Instantly accepted the test-email lead; the selected OUTBOUND row was not modified.',
      outbound_id: outboundId,
      instantly_lead_id: uploaded.leadId,
      payload: uploaded.payload,
    };
  }
  return {
    ok: true,
    test_mode: false,
    outbound_id: outboundId,
    instantly_lead_id: uploaded.leadId,
    instantly_added_at: uploaded.timestamp,
    outbound_status: record.obj.outbound_status,
  };
}

export async function uploadEligibleOutboundLeads(repo, {
  apiKey,
  campaignId,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  concurrency = 3,
} = {}) {
  if (!nonblank(apiKey)) throw new Error('INSTANTLY_API_KEY is not set');
  if (!nonblank(campaignId)) throw new Error('INSTANTLY_CAMPAIGN_ID is not set');
  if (typeof fetchImpl !== 'function') throw new Error('Instantly fetch transport is unavailable');

  const table = await repo.getTable('OUTBOUND');
  const records = recordsFromTable(table).sort((a, b) => a.obj.outbound_id.localeCompare(b.obj.outbound_id));
  const eligible = [];
  const skipped = [];
  const skipReasons = {};

  for (const record of records) {
    const reasons = outboundEligibilityReasons(record.obj);
    if (!reasons.length) {
      eligible.push(record);
      continue;
    }
    skipped.push({ outbound_id: record.obj.outbound_id, reasons });
    for (const reason of reasons) skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  }

  const uploaded = [];
  const failures = [];
  const boundedConcurrency = Math.max(1, Math.min(5, Math.floor(Number(concurrency)) || 3));

  // Small chunks bound both Instantly and Sheets traffic. Each row writes its
  // marker immediately after Instantly returns a valid lead ID, so a rerun
  // skips all committed successes even when another row in the batch fails.
  for (let index = 0; index < eligible.length; index += boundedConcurrency) {
    const chunk = eligible.slice(index, index + boundedConcurrency);
    const outcomes = await Promise.all(chunk.map(async (record) => {
      try {
        const result = await uploadRecord(repo, table, record, {
          apiKey,
          campaignId,
          fetchImpl,
          now,
        });
        return {
          ok: true,
          outbound_id: record.obj.outbound_id,
          instantly_lead_id: result.leadId,
          instantly_added_at: result.timestamp,
        };
      } catch (err) {
        return {
          ok: false,
          outbound_id: record.obj.outbound_id,
          error: err?.message || String(err),
        };
      }
    }));
    for (const outcome of outcomes) {
      if (outcome.ok) uploaded.push(outcome);
      else failures.push(outcome);
    }
  }

  return {
    ok: failures.length === 0,
    dry_run: false,
    total_rows: records.length,
    eligible_rows: eligible.length,
    uploaded_rows: uploaded.length,
    failed_rows: failures.length,
    skipped_rows: skipped.length,
    skip_reasons: skipReasons,
    skipped,
    uploaded,
    failures,
    concurrency: boundedConcurrency,
  };
}

export const _internal = { assertRequiredHeaders, recordsFromTable, failureMessage, validTestEmail };
