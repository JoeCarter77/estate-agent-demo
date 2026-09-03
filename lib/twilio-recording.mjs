// Server-side Twilio recording retrieval for the protected operator UI.
// Twilio credentials never reach the browser. The browser supplies only a
// COMMUNICATIONS id; the API resolves recording_reference from Sheets and this
// helper accepts only Twilio's API hostname before making any request.

function text(value) {
  return String(value ?? '').trim();
}

function accountSidFromUrl(url) {
  return url.pathname.match(/\/Accounts\/(AC[a-zA-Z0-9]+)\//)?.[1] || '';
}

function recordingUrl(reference) {
  const raw = text(reference);
  if (!raw) throw new Error('Communication has no recording_reference');
  if (/^RE[a-zA-Z0-9]+$/.test(raw)) {
    const accountSid = text(process.env.TWILIO_ACCOUNT_SID);
    if (!accountSid) throw new Error('TWILIO_ACCOUNT_SID is required for RecordingSid-only references');
    return new URL(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${raw}.mp3`);
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid Twilio recording_reference'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com') {
    throw new Error('Recording reference is not a Twilio API URL');
  }
  if (!/\/Recordings\/RE[a-zA-Z0-9]+(?:\.[a-z0-9]+)?$/i.test(url.pathname)) {
    throw new Error('Recording reference is not a Twilio Recording resource');
  }
  if (!/\.(mp3|wav)$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}.mp3`;
  url.search = '';
  url.hash = '';
  return url;
}

export async function fetchTwilioRecording(reference, { fetchImpl = globalThis.fetch } = {}) {
  const authToken = text(process.env.TWILIO_AUTH_TOKEN);
  if (!authToken) throw new Error('TWILIO_AUTH_TOKEN is not configured');
  const url = recordingUrl(reference);
  const accountSid = text(process.env.TWILIO_ACCOUNT_SID) || accountSidFromUrl(url);
  if (!accountSid) throw new Error('Unable to resolve Twilio Account SID');
  const authorization = Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64');
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Basic ${authorization}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Twilio recording fetch failed (${response.status})${body ? `: ${body.slice(0, 160)}` : ''}`);
    err.statusCode = response.status;
    throw err;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get('content-type') || 'audio/mpeg',
    contentLength: response.headers.get('content-length') || String(bytes.length),
  };
}
