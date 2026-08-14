// lib/probes.mjs
// Live probe-data lookup from a Google Sheet, keyed on Slug. Read per request so
// editing the sheet is reflected on the next page load with no redeploy.
//
// Env vars (read from process.env only - never hardcode):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  - service account with read access to the sheet
//   GOOGLE_PRIVATE_KEY            - its private key ("\n" escapes are un-escaped below)
//   PROBE_SHEET_ID               - the spreadsheet id
//
// If any of those are missing, or the fetch fails, getProbeData returns null so the
// page simply renders no proof block (never a broken/partial line).
import { google } from 'googleapis';

const RANGE = 'Sheet1!A:Z'; // adjust the tab name if the sheet's tab isn't "Sheet1"

function getSheetClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

export async function getProbeData(slug) {
  const SHEET_ID = process.env.PROBE_SHEET_ID;
  if (!SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return null; // not configured yet - no proof block
  }

  try {
    const sheets = getSheetClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });

    const rows = res.data.values ?? [];
    if (!rows.length) return null;

    const [header, ...dataRows] = rows;
    const idx = (name) => header.indexOf(name);
    if (idx('Slug') === -1) return null;

    const match = dataRows.find((r) => r[idx('Slug')] === slug);
    if (!match) return null;

    const get = (name) => {
      const i = idx(name);
      return i === -1 ? '' : (match[i] || '');
    };

    return {
      slug: get('Slug'),
      probeSent: get('Probe Sent'),
      probeAddress: get('Probe Address'),
      firstReply: get('First Reply'),
      lagHrs: get('Lag (hrs)'),
      outcome: get('Outcome'),
    };
  } catch (e) {
    console.error('getProbeData failed:', e && e.message ? e.message : e);
    return null;
  }
}
