// google-apps-script/RecomputeOnMatchStatusChange.gs — auto-recompute
// Intelligence when a human manually resolves a COMMUNICATIONS row's
// match_status from "unmatched" to "matched" directly in the Google Sheet.
//
// Every OTHER path that can make this same transition (the communications
// webhooks — api/novus/webhooks/*.js) already calls the single-probe
// recompute path in-process (lib/observation-recompute.mjs's
// recomputeProbeObservation(), reached here via
// POST /api/novus/intelligence/rebuild-all { probe_id }) the moment it
// happens. A manual edit in Sheets is invisible to that code — nothing in
// the app is watching cell edits — so until this trigger exists, a manually
// resolved row just sits there with a stale INTELLIGENCE row. This file
// closes that gap with an installable onEdit trigger that is a THIN CLIENT
// ONLY, same as RebuildIntelligence.gs: it does no matching/grading logic of
// its own, it just detects the one specific transition and calls the
// existing endpoint.
//
// SINGLE-PROBE ONLY, NEVER A FULL REBUILD: this always calls
// POST /api/novus/intelligence/rebuild-all with { probe_id: <that row's
// PROBES id> } — the single-probe branch of that endpoint, which
// short-circuits before the full-rebuild path and returns without touching
// any other probe. DIAGNOSIS is written by that same call ONLY if the
// probe's observation window has already closed — existing, unchanged
// lifecycle logic (lib/observation-recompute.mjs), not something this
// trigger decides.
//
// WHY AN INSTALLABLE TRIGGER, NOT A SIMPLE onEdit(e): a simple trigger
// (a bare `function onEdit(e)`) runs with restricted authorization and
// cannot call UrlFetchApp. An installable trigger, created once via
// installMatchStatusTrigger() below, runs with the installing user's full
// authorization and can call the API. See "One-time setup" in README.md.

// NOTE ON onOpen(): a script project can only have ONE function named
// onOpen() — it does not matter which .gs file it's written in, they all
// share one global scope. RebuildIntelligence.gs already defines onOpen()
// and builds the NOVUS menu, so its menu now also includes "Install
// auto-recompute on manual match" (see that file) rather than this file
// defining a second, colliding onOpen(). Run that menu item once, or call
// installMatchStatusTrigger() directly from the Apps Script editor.

// Run this once (NOVUS menu -> "Install auto-recompute on manual match").
// Idempotent: removes any trigger this script previously installed for
// onMatchStatusEdit before adding a fresh one, so re-running it after
// re-pasting this file never creates duplicates (which would otherwise fire
// the same recompute twice per edit).
function installMatchStatusTrigger() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'onMatchStatusEdit')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('onMatchStatusEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  ui.alert(
    'Installed',
    'Editing COMMUNICATIONS.match_status from "unmatched" to "matched" will now ' +
      'automatically recompute Intelligence for that row\'s probe.',
    ui.ButtonSet.OK
  );
}

// The installable trigger handler. Fires on every edit anywhere in the
// spreadsheet; does nothing unless the edit is exactly the transition this
// automation cares about.
function onMatchStatusEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'COMMUNICATIONS') return;

  // Only a single-cell edit carries e.oldValue (a paste/fill across a range
  // does not) — restricting to that keeps this a simple, unambiguous "one
  // cell went from X to Y" check rather than guessing at a multi-cell paste.
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const matchStatusCol = header.indexOf('match_status') + 1;
  const probeIdCol = header.indexOf('probe_id') + 1;
  if (!matchStatusCol || !probeIdCol) return; // header row missing a required column
  if (e.range.getColumn() !== matchStatusCol) return;

  const oldValue = String(e.oldValue || '').trim();
  const newValue = String(e.value || '').trim();
  if (oldValue !== 'unmatched' || newValue !== 'matched') return;

  const editedRow = e.range.getRow();
  const probeId = String(sheet.getRange(editedRow, probeIdCol).getValue() || '').trim();
  if (!probeId) return; // nothing to recompute without a probe_id on this row

  recomputeProbe_(probeId);
}

// Calls the existing single-probe recompute endpoint. Same Script
// Properties as RebuildIntelligence.gs's rebuildIntelligence() — see
// README.md's "One-time setup".
function recomputeProbe_(probeId) {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = (props.getProperty('NOVUS_API_BASE_URL') || '').replace(/\/+$/, '');
  const user = props.getProperty('NOVUS_BASIC_AUTH_USER') || '';
  const pass = props.getProperty('NOVUS_BASIC_AUTH_PASS') || '';
  if (!baseUrl || !user || !pass) {
    console.error('recomputeProbe_: NOVUS_API_BASE_URL/NOVUS_BASIC_AUTH_USER/NOVUS_BASIC_AUTH_PASS not configured');
    return;
  }

  try {
    const response = UrlFetchApp.fetch(baseUrl + '/api/novus/intelligence/rebuild-all', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ probe_id: probeId }),
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(user + ':' + pass) },
      muteHttpExceptions: true,
    });
    const status = response.getResponseCode();
    if (status !== 200) {
      console.error('recomputeProbe_: rebuild-all returned ' + status + ' for probe ' + probeId + ': ' + response.getContentText());
    }
  } catch (err) {
    console.error('recomputeProbe_: request failed for probe ' + probeId + ': ' + err.message);
  }
}
