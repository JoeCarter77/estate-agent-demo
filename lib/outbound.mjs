// Deterministic NOVUS OUTBOUND compiler.
//
// This layer only compiles the current Sheets state into an outbound-ready
// queue. It deliberately contains no Instantly integration and sends nothing.

import { newOutboundId } from './ids.mjs';

export const OUTBOUND_TAB = 'OUTBOUND';
export const OUTBOUND_HEADER = [
  'outbound_id', 'agency_id', 'probe_id', 'clean_agency_name',
  'outreach_contact_name', 'first_name', 'outreach_contact_email',
  'email_verification_status', 'property_street', 'probe_date', 'probe_time',
  'email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2',
  'demo_slug', 'demo_url', 'outbound_status', 'instantly_lead_id',
  'instantly_added_at', 'last_error', 'created_at', 'updated_at',
];

export const OUTBOUND_STATUSES = ['READY', 'SENT', 'ERROR', 'SUPPRESSED'];
export const DEMO_BASE_URL = 'https://demo.getnovus.co.uk';

const SOURCE_SPECS = {
  AGENCIES: ['agency_id', 'clean_agency_name', 'outreach_contact_name', 'outreach_contact_email', 'email_verification_status'],
  PROBES: ['agency_id', 'probe_id', 'property_street'],
  PERSONALISATION: ['agency_id', 'probe_id', 'email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2'],
  DEMOS: ['agency_id', 'probe_id', 'demo_slug', 'demo_status', 'property_image_status', 'enquiry_date', 'enquiry_time'],
  OUTBOUND: OUTBOUND_HEADER,
};

const EXECUTION_FIELDS = [
  'outbound_status', 'instantly_lead_id', 'instantly_added_at', 'last_error',
];

function nonblank(value) {
  return String(value ?? '').trim().length > 0;
}

function businessKey(agencyId, probeId) {
  return `${String(agencyId ?? '')}\u0000${String(probeId ?? '')}`;
}

function displayKey(agencyId, probeId) {
  return `${String(agencyId ?? '') || '(blank agency_id)'} / ${String(probeId ?? '') || '(blank probe_id)'}`;
}

function rowObject(header, row) {
  return Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']));
}

function recordsOf(table, idColumn) {
  const idIndex = table.header.indexOf(idColumn);
  return table.rows.flatMap((row, index) => {
    const id = idIndex < 0 ? '' : row[idIndex] ?? '';
    if (!id || id === 'SCHEMA NOTE') return [];
    return [{ rowNumber: index + 2, obj: rowObject(table.header, row) }];
  });
}

function assertHeaders(tables) {
  for (const [tab, required] of Object.entries(SOURCE_SPECS)) {
    const header = tables[tab]?.header || [];
    const missing = required.filter((column) => !header.includes(column));
    if (missing.length) throw new Error(`${tab} is missing required column(s): ${missing.join(', ')}`);
  }
}

function uniqueIndex(records, keyOf) {
  const byKey = new Map();
  const duplicateKeys = new Set();
  for (const record of records) {
    const key = keyOf(record.obj);
    if (byKey.has(key)) duplicateKeys.add(key);
    else byKey.set(key, record);
  }
  return { byKey, duplicateKeys };
}

// Take a name only when its first usable token looks like a human given name.
// Known honorifics are skipped; generic/contact-like text is not invented into
// a greeting. The source contact name itself is always preserved unchanged.
export function deriveFirstName(contactName) {
  const text = String(contactName ?? '').trim();
  if (!text || text.includes('@')) return '';
  const tokens = text.split(/\s+/).filter(Boolean);
  const honorifics = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'sir', 'dame']);
  while (tokens.length && honorifics.has(tokens[0].replace(/[.]/g, '').toLowerCase())) tokens.shift();
  const nonPersonTokens = new Set([
    'agency', 'agents', 'branch', 'enquiries', 'estate', 'estates', 'group',
    'lettings', 'office', 'properties', 'property', 'sales', 'team',
  ]);
  if (tokens.some((token) => nonPersonTokens.has(token.replace(/[.,]/g, '').toLowerCase()))) return '';
  const first = tokens[0] || '';
  if (!/^[\p{L}][\p{L}'’.-]*$/u.test(first)) return '';
  return first;
}

function eligibilityReasons({ agency, probe, personalisation, demo, duplicateReasons = [] }) {
  const reasons = [...duplicateReasons];
  if (!demo) reasons.push('missing DEMOS match for exact agency_id + probe_id');
  else {
    if (demo.demo_status !== 'ready') reasons.push('demo_status != ready');
    if (demo.property_image_status !== 'ok') reasons.push('property_image_status != ok');
    if (!nonblank(demo.demo_slug)) reasons.push('missing demo_slug');
    if (!nonblank(demo.enquiry_date)) reasons.push('missing enquiry_date');
    if (!nonblank(demo.enquiry_time)) reasons.push('missing enquiry_time');
  }

  if (!agency) reasons.push('missing AGENCIES match for exact agency_id');
  else {
    if (!nonblank(agency.outreach_contact_email)) reasons.push('missing outreach_contact_email');
    if (!['VALID', 'RISKY'].includes(agency.email_verification_status)) {
      reasons.push(`email_verification_status ${agency.email_verification_status || '(blank)'}`);
    }
    if (!nonblank(agency.clean_agency_name)) reasons.push('missing clean_agency_name');
  }

  if (!nonblank(probe.property_street)) reasons.push('missing property_street');

  if (!personalisation) reasons.push('missing PERSONALISATION match for exact agency_id + probe_id');
  else {
    for (const field of ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2']) {
      if (!nonblank(personalisation[field])) reasons.push(`missing ${field}`);
    }
  }
  return reasons;
}

function compiledFields({ agency, probe, personalisation, demo }) {
  return {
    agency_id: probe.agency_id,
    probe_id: probe.probe_id,
    clean_agency_name: agency.clean_agency_name,
    outreach_contact_name: agency.outreach_contact_name,
    first_name: deriveFirstName(agency.outreach_contact_name),
    outreach_contact_email: agency.outreach_contact_email,
    email_verification_status: agency.email_verification_status,
    property_street: probe.property_street,
    probe_date: demo.enquiry_date,
    probe_time: demo.enquiry_time,
    // These values are assigned directly: eligibility trims only for the blank
    // check, never for the queue value itself.
    email_observation: personalisation.email_observation,
    email_commercial_hook: personalisation.email_commercial_hook,
    email_commercial_hook_email_2: personalisation.email_commercial_hook_email_2,
    demo_slug: demo.demo_slug,
    demo_url: `${DEMO_BASE_URL}/${demo.demo_slug}`,
  };
}

export function buildOutboundPlan(tables, {
  now = new Date().toISOString(),
  idFactory = newOutboundId,
} = {}) {
  assertHeaders(tables);

  const agencies = recordsOf(tables.AGENCIES, 'agency_id');
  const probes = recordsOf(tables.PROBES, 'probe_id');
  const personalisations = recordsOf(tables.PERSONALISATION, 'probe_id');
  const demos = recordsOf(tables.DEMOS, 'probe_id');
  // The business key, not outbound_id, decides whether a row already exists.
  // This also repairs a malformed legacy row whose outbound_id is blank rather
  // than appending a duplicate agency + probe pair.
  const outbound = recordsOf(tables.OUTBOUND, 'probe_id');

  const agencyIndex = uniqueIndex(agencies, (obj) => String(obj.agency_id ?? ''));
  const probeIndex = uniqueIndex(probes, (obj) => businessKey(obj.agency_id, obj.probe_id));
  const personalisationIndex = uniqueIndex(personalisations, (obj) => businessKey(obj.agency_id, obj.probe_id));
  const demoIndex = uniqueIndex(demos, (obj) => businessKey(obj.agency_id, obj.probe_id));
  const outboundIndex = uniqueIndex(outbound, (obj) => businessKey(obj.agency_id, obj.probe_id));

  if (outboundIndex.duplicateKeys.size) {
    const keys = [...outboundIndex.duplicateKeys].map((key) => {
      const [agencyId, probeId] = key.split('\u0000');
      return displayKey(agencyId, probeId);
    });
    throw new Error(`OUTBOUND contains duplicate agency_id + probe_id rows: ${keys.join(', ')}`);
  }

  const skipped = [];
  const creates = [];
  const updates = [];
  const seenProbeKeys = new Set();

  for (const probeRecord of probes) {
    const probe = probeRecord.obj;
    const key = businessKey(probe.agency_id, probe.probe_id);
    if (seenProbeKeys.has(key)) continue;
    seenProbeKeys.add(key);

    const duplicateReasons = [];
    if (probeIndex.duplicateKeys.has(key)) duplicateReasons.push('duplicate PROBES rows for exact agency_id + probe_id');
    if (agencyIndex.duplicateKeys.has(String(probe.agency_id ?? ''))) duplicateReasons.push('duplicate AGENCIES rows for exact agency_id');
    if (personalisationIndex.duplicateKeys.has(key)) duplicateReasons.push('duplicate PERSONALISATION rows for exact agency_id + probe_id');
    if (demoIndex.duplicateKeys.has(key)) duplicateReasons.push('duplicate DEMOS rows for exact agency_id + probe_id');

    const agency = agencyIndex.byKey.get(String(probe.agency_id ?? ''))?.obj || null;
    const personalisation = personalisationIndex.byKey.get(key)?.obj || null;
    const demo = demoIndex.byKey.get(key)?.obj || null;
    const reasons = eligibilityReasons({ agency, probe, personalisation, demo, duplicateReasons });
    if (reasons.length) {
      skipped.push({ agency_id: probe.agency_id, probe_id: probe.probe_id, reasons });
      continue;
    }

    const compiled = compiledFields({ agency, probe, personalisation, demo });
    const existing = outboundIndex.byKey.get(key);
    if (existing) {
      const row = {
        ...existing.obj,
        ...compiled,
        outbound_id: existing.obj.outbound_id || idFactory(),
        created_at: existing.obj.created_at || now,
        updated_at: now,
      };
      // Make the state-preservation contract explicit even if compiled fields
      // grow later: rebuilds never reset delivery state.
      for (const field of EXECUTION_FIELDS) row[field] = existing.obj[field] ?? '';
      updates.push({ rowNumber: existing.rowNumber, row });
    } else {
      creates.push({
        row: {
          outbound_id: idFactory(),
          ...compiled,
          outbound_status: 'READY',
          instantly_lead_id: '',
          instantly_added_at: '',
          last_error: '',
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  return {
    eligible_count: creates.length + updates.length,
    skipped_count: skipped.length,
    create_count: creates.length,
    update_count: updates.length,
    skipped,
    creates,
    updates,
  };
}

export async function rebuildOutbound(repo, {
  dryRun = true,
  now = () => new Date().toISOString(),
  idFactory = newOutboundId,
} = {}) {
  const [agencies, probes, personalisation, demos, outbound] = await Promise.all([
    repo.getTable('AGENCIES'),
    repo.getTable('PROBES'),
    repo.getTable('PERSONALISATION'),
    repo.getTable('DEMOS'),
    repo.getTable(OUTBOUND_TAB),
  ]);
  const tables = { AGENCIES: agencies, PROBES: probes, PERSONALISATION: personalisation, DEMOS: demos, OUTBOUND: outbound };
  const plan = buildOutboundPlan(tables, { now: now(), idFactory });

  if (!dryRun) {
    const header = outbound.header;
    const updateWrites = plan.updates.map(({ rowNumber, row }) => ({
      tab: OUTBOUND_TAB,
      rowNumber,
      row: header.map((column) => row[column] ?? ''),
    }));
    const appendRows = plan.creates.map(({ row }) => header.map((column) => row[column] ?? ''));
    await repo.writeRowsBatch(updateWrites);
    await repo.appendRowsBatch(OUTBOUND_TAB, appendRows);
  }

  return {
    dry_run: dryRun,
    eligible_count: plan.eligible_count,
    skipped_count: plan.skipped_count,
    create_count: plan.create_count,
    update_count: plan.update_count,
    skipped: plan.skipped,
    rows_to_create: plan.creates.map(({ row }) => row),
    rows_to_update: plan.updates.map(({ row }) => row),
  };
}
