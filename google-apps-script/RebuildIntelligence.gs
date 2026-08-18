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

// The button's click handler. Calls the rebuild-all endpoint, waits for the
// response, and shows a simple success/error alert containing the rebuild
// summary the API returned. No local computation of any kind.
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

  SpreadsheetApp.getActiveSpreadsheet().toast('Rebuilding intelligence for every probe…', 'NOVUS', -1);

  // ONE-OFF: also runs the historical COMMUNICATIONS.contact_quality
  // backfill (lib/communications-backfill.mjs) in the same request — see
  // api/novus/intelligence/rebuild-all.js. Revert this payload back to {}
  // once the one-time backfill has run and been verified in the live sheet,
  // so future clicks of this button don't keep re-running it.
  let response;
  try {
    response = UrlFetchApp.fetch(baseUrl + '/api/novus/intelligence/rebuild-all', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ backfill_contact_quality: true }),
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(user + ':' + pass) },
      muteHttpExceptions: true,
    });
  } catch (err) {
    ui.alert('Rebuild Intelligence — failed', 'Request failed: ' + err.message, ui.ButtonSet.OK);
    return;
  }

  const status = response.getResponseCode();
  let body = {};
  try { body = JSON.parse(response.getContentText()); } catch (e) { /* leave body = {} */ }

  if (status !== 200) {
    ui.alert(
      'Rebuild Intelligence — failed',
      'Server returned ' + status + ': ' + (body.error || response.getContentText()),
      ui.ButtonSet.OK
    );
    return;
  }

  const diagnosis = body.diagnosis || {};
  const lines = [
    'Probes processed: ' + body.probes_processed,
    'Probes with communications: ' + body.probes_with_communications,
    'Probes with zero communications: ' + body.probes_with_zero_communications,
    'Intelligence created: ' + body.intelligence_created,
    'Intelligence updated: ' + body.intelligence_updated,
    'Problems: ' + (body.problems ? body.problems.length : 0),
    '',
    'Diagnosis created: ' + diagnosis.diagnosis_created,
    'Diagnosis updated: ' + diagnosis.diagnosis_updated,
    'Diagnosis skipped (not closed): ' + diagnosis.skipped_not_closed,
    'Diagnosis problems: ' + (diagnosis.problems ? diagnosis.problems.length : 0),
  ];
  ui.alert('Rebuild Intelligence — complete', lines.join('\n'), ui.ButtonSet.OK);
}
