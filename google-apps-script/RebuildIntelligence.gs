// google-apps-script/RebuildIntelligence.gs — a "REBUILD INTELLIGENCE" button
// for the NOVUS Google Sheet UI (bound Apps Script, pasted into the
// NOVUS_Data_V1_Master_v2 spreadsheet — see README.md in this folder for the
// one-time setup steps).
//
// This is a THIN CLIENT ONLY. It does not read/write sheet cells and it does
// not contain any grading/evidence/matching logic — it just calls the
// existing backend endpoint and shows the response:
//
//   POST /api/novus/intelligence/rebuild-all
//
// which is the same canonical full-rebuild path used everywhere else
// (lib/intelligence-rebuild.mjs). All intelligence logic stays in code, not
// in Sheets — this script deliberately does nothing but trigger it and
// display the summary the API already computed.
//
// Same NOVUS_BASIC_AUTH credential the rest of /api/novus/* uses. Apps
// Script can't read Vercel env vars, so the base URL + credentials are read
// from this script's own Script Properties (Project Settings > Script
// Properties in the Apps Script editor) — never hardcoded here:
//   NOVUS_API_BASE_URL   e.g. https://<your-deployment>.vercel.app
//   NOVUS_BASIC_AUTH_USER
//   NOVUS_BASIC_AUTH_PASS

// Adds the "NOVUS" menu (with the Rebuild Intelligence button) every time
// the spreadsheet is opened. Standard Apps Script simple-trigger — runs
// automatically, no manual install step beyond pasting this file in once.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('NOVUS')
    .addItem('Rebuild Intelligence', 'rebuildIntelligence')
    .addToUi();
}

// The button's click handler. Calls the rebuild-all endpoint REPEATEDLY —
// each call is bounded server-side to a small AI-call budget per invocation
// (see the batching note atop api/novus/intelligence/rebuild-all.js) so a
// large historical dataset never makes one call run long enough to hit the
// Vercel function timeout. The endpoint reports `complete: false` plus how
// much work is left after each bounded call; this loop keeps calling until
// `complete: true` (or a hard iteration cap is hit, as a safety net against
// an infinite loop), accumulating totals, then shows ONE final success/
// failure alert for the whole run. No local computation of any kind — this
// is still a thin client, it just now drives the batches.
function rebuildIntelligence() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const baseUrl = (props.getProperty('NOVUS_API_BASE_URL') || '').replace(/\/+$/, '');
  const user = props.getProperty('NOVUS_BASIC_AUTH_USER') || '';
  const pass = props.getProperty('NOVUS_BASIC_AUTH_PASS') || '';

  if (!baseUrl || !user || !pass) {
    ui.alert(
      'Rebuild Intelligence — not configured',
      'Set NOVUS_API_BASE_URL, NOVUS_BASIC_AUTH_USER and NOVUS_BASIC_AUTH_PASS in ' +
        'Project Settings → Script Properties, then try again.',
      ui.ButtonSet.OK
    );
    return;
  }

  // Generous but finite — each call processes a real chunk of work, so this
  // caps a single button click at a very large amount of total AI calls
  // before giving up and telling the user to click it again (safe: the
  // endpoint is idempotent and resumes from wherever it stopped).
  const MAX_BATCHES = 200;

  const totals = {
    probes_processed: 0,
    intelligence_created: 0,
    intelligence_updated: 0,
    problems: 0,
    diagnosis_created: 0,
    diagnosis_updated: 0,
    diagnosis_skipped_not_closed: 0,
    diagnosis_problems: 0,
  };
  let batches = 0;
  let complete = false;
  let lastBody = null;

  for (; batches < MAX_BATCHES; batches++) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Rebuilding intelligence for every probe… (batch ' + (batches + 1) + ')', 'NOVUS', -1
    );

    let response;
    try {
      response = UrlFetchApp.fetch(baseUrl + '/api/novus/intelligence/rebuild-all', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({}),
        headers: { Authorization: 'Basic ' + Utilities.base64Encode(user + ':' + pass) },
        muteHttpExceptions: true,
      });
    } catch (err) {
      ui.alert(
        'Rebuild Intelligence — failed',
        'Request failed on batch ' + (batches + 1) + ': ' + err.message +
          '\n\nProgress so far is saved — click Rebuild Intelligence again to resume.',
        ui.ButtonSet.OK
      );
      return;
    }

    const status = response.getResponseCode();
    let body = {};
    try { body = JSON.parse(response.getContentText()); } catch (e) { /* leave body = {} */ }

    if (status !== 200) {
      ui.alert(
        'Rebuild Intelligence — failed',
        'Server returned ' + status + ' on batch ' + (batches + 1) + ': ' +
          (body.error || response.getContentText()) +
          '\n\nProgress so far is saved — click Rebuild Intelligence again to resume.',
        ui.ButtonSet.OK
      );
      return;
    }

    lastBody = body;
    const diagnosis = body.diagnosis || {};
    totals.probes_processed += body.probes_processed || 0;
    totals.intelligence_created += body.intelligence_created || 0;
    totals.intelligence_updated += body.intelligence_updated || 0;
    totals.problems += (body.problems ? body.problems.length : 0);
    totals.diagnosis_created += diagnosis.diagnosis_created || 0;
    totals.diagnosis_updated += diagnosis.diagnosis_updated || 0;
    totals.diagnosis_skipped_not_closed += diagnosis.skipped_not_closed || 0;
    totals.diagnosis_problems += (diagnosis.problems ? diagnosis.problems.length : 0);

    if (body.complete) { complete = true; break; }
  }

  const lastDiagnosis = (lastBody && lastBody.diagnosis) || {};
  const lines = [
    'Batches run: ' + (batches + (complete ? 1 : 0)),
    'Probes with communications (last batch): ' + (lastBody ? lastBody.probes_with_communications : 'n/a'),
    'Probes with zero communications (last batch): ' + (lastBody ? lastBody.probes_with_zero_communications : 'n/a'),
    'Intelligence created (total): ' + totals.intelligence_created,
    'Intelligence updated (total): ' + totals.intelligence_updated,
    'Problems (total): ' + totals.problems,
    '',
    'Diagnosis created (total): ' + totals.diagnosis_created,
    'Diagnosis updated (total): ' + totals.diagnosis_updated,
    'Diagnosis skipped (not closed, last batch): ' + (lastDiagnosis.skipped_not_closed || 0),
    'Diagnosis problems (total): ' + totals.diagnosis_problems,
  ];

  if (!complete) {
    lines.push('', 'NOT FINISHED — hit the ' + MAX_BATCHES + '-batch safety cap for this click.',
      'Click Rebuild Intelligence again to continue; it resumes automatically.');
    ui.alert('Rebuild Intelligence — incomplete', lines.join('\n'), ui.ButtonSet.OK);
    return;
  }

  ui.alert('Rebuild Intelligence — complete', lines.join('\n'), ui.ButtonSet.OK);
}
