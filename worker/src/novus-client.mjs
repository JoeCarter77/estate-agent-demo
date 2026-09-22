// worker/src/novus-client.mjs — READ-ONLY verification against the real NOVUS.
//
// The operator never writes to NOVUS over HTTP. Every mutation (create probe,
// mark as sent, skip agency) happens by clicking the existing Prober UI, so
// there is exactly one implementation of those operations and the automated
// run is indistinguishable from a manual one in the database.
//
// This client exists for the other half of step 11: "verify that the actual
// existing backend records the probe as sent". Reading the probe row back
// through the same /api/novus/probe route proves the write landed, rather than
// trusting the button's own success styling.

export class NovusClient {
  constructor(config) {
    this.base = config.novusBaseUrl;
    this.auth = 'Basic ' + Buffer.from(`${config.basicAuthUser}:${config.basicAuthPass}`).toString('base64');
  }

  async get(path) {
    const response = await fetch(`${this.base}${path}`, { headers: { Authorization: this.auth } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `NOVUS ${path} failed (${response.status})`);
    return data;
  }

  queue() { return this.get('/api/novus/probe?queue=1'); }
  probe(probeId) { return this.get(`/api/novus/probe?probe_id=${encodeURIComponent(probeId)}`); }
  agency(agencyId) { return this.get(`/api/novus/probe?agency_id=${encodeURIComponent(agencyId)}`); }
  nextAgency() { return this.get('/api/novus/probe?next=1'); }
}

// Step 11's backend assertion, expressed once.
export function isProbeRecordedAsSent(probe) {
  return Boolean(probe)
    && String(probe.probe_status || '').trim() === 'observing'
    && Boolean(String(probe.probe_timestamp || '').trim())
    && Boolean(String(probe.observation_deadline || '').trim());
}
