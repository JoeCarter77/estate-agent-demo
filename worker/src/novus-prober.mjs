// worker/src/novus-prober.mjs — driving the EXISTING Prober page.
//
// Every selector below already exists in novus/probe.html and is untouched by
// this project. The operator clicks the same controls a human clicks, in the
// same order, so the resulting PROBES row, probe_reference, probe_email,
// probe_phone, observation window and AGENCIES.probe_sent stamp are produced
// by the existing code paths and nothing else.
//
//   #agency-name     read-only agency name for the loaded queue row
//   #rm-agent-link   "Open Rightmove agent page" (AGENCIES.rightmove_sales_branch_url)
//   #url             the Rightmove property URL field
//   #create-btn      Create probe
//   #view-ready      the "Probe ready" screen
//   #f-ref           probe_reference
//   #sent-btn        Mark as sent
//   #status-text     Draft | Observing
//   #skip-reason     the existing skip reason select
//   #skip-btn        Skip agency (hard delete, confirm() dialog)

import { dismissCookieBanner } from './browser.mjs';

const READY = '#view-ready';

export class ProberPage {
  constructor(page, config) {
    this.page = page;
    this.config = config;
  }

  url(path) { return `${this.config.novusBaseUrl}${path}`; }

  // STEP 1 — "Start probing". The Command Centre's button is a link to
  // /novus/probe?next=1; the Prober page then resolves the next eligible
  // agency itself and redirects to ?agency_id=. Waiting for that redirect is
  // what "do not assume the page is ready immediately after navigation" means
  // here: the agency is not known until the redirect has happened.
  async startProbing() {
    await this.page.goto(this.url('/novus/probe?next=1'), { waitUntil: 'domcontentloaded' });
    return this.waitForAgencyLoaded();
  }

  async openAgency(agencyId) {
    await this.page.goto(this.url(`/novus/probe?agency_id=${encodeURIComponent(agencyId)}`), { waitUntil: 'domcontentloaded' });
    return this.waitForAgencyLoaded();
  }

  // The queue can legitimately be empty, and the page reports that as an error
  // in #create-err rather than as an HTTP failure. Distinguish the two.
  async waitForAgencyLoaded() {
    await this.page.waitForFunction(() => {
      const field = document.getElementById('agency-field');
      const err = document.getElementById('create-err');
      const loaded = field && !field.classList.contains('hidden')
        && document.getElementById('agency-name')?.value;
      return Boolean(loaded) || Boolean(err && err.textContent.trim());
    }, undefined, { timeout: this.config.timeouts.control });

    const error = (await this.page.locator('#create-err').innerText().catch(() => '')).trim();
    const agencyId = new URL(this.page.url()).searchParams.get('agency_id') || '';
    if (!agencyId) {
      return { empty: true, error: error || 'No eligible agency is ready to probe' };
    }
    if (error) return { empty: false, agencyId, error };

    // The branch link is only rendered once AGENCIES.rightmove_sales_branch_url
    // has been read back, so waiting for the name is not enough.
    const name = await this.page.locator('#agency-name').inputValue();
    const branchUrl = await this.page.locator('#rm-agent-link')
      .getAttribute('href', { timeout: 5000 }).catch(() => '');
    return { empty: false, agencyId, agencyName: name, branchUrl: branchUrl && branchUrl !== '#' ? branchUrl : '' };
  }

  // The Prober auto-opens the branch page with window.open on load. That popup
  // is a Rightmove tab like any other and the orchestrator adopts it; this
  // method is the explicit STEP 2 click used when it was blocked.
  branchLink() { return this.page.locator('#rm-agent-link'); }

  // STEP 10 — paste the captured property URL and create the probe.
  async createProbe(propertyUrl) {
    await this.page.locator('#url').fill(propertyUrl);
    await this.page.locator('#create-btn').click();
    await this.page.waitForFunction(() => {
      const ready = document.getElementById('view-ready');
      const err = document.getElementById('create-err');
      return (ready && !ready.classList.contains('hidden')) || Boolean(err && err.textContent.trim());
    }, undefined, { timeout: this.config.timeouts.control });

    const error = (await this.page.locator('#create-err').innerText().catch(() => '')).trim();
    if (error) return { ok: false, error };
    const visible = await this.page.locator(READY).isVisible();
    if (!visible) return { ok: false, error: 'Create probe produced neither the ready screen nor an error' };
    return {
      ok: true,
      reference: (await this.page.locator('#f-ref').innerText()).trim(),
      agency: (await this.page.locator('#f-agency').innerText()).trim(),
      address: (await this.page.locator('#f-address').innerText()).trim(),
      email: (await this.page.locator('#f-email').innerText()).trim(),
      phone: (await this.page.locator('#f-phone').innerText()).trim(),
      status: (await this.page.locator('#status-text').innerText()).trim(),
    };
  }

  // The Prober does not expose probe_id in the DOM; it keeps it in the page's
  // `currentProbe`. Reading it is how the operator can verify the row through
  // the API afterwards without inventing an id.
  async currentProbeId() {
    return this.page.evaluate(() => (window.currentProbe && window.currentProbe.probe_id)
      || (typeof currentProbe !== 'undefined' && currentProbe ? currentProbe.probe_id : '')).catch(() => '');
  }

  // STEP 11 — Mark as sent. On success the existing page immediately navigates
  // to the next agency, so "sent" is confirmed by either the Observing status
  // or that navigation, whichever the page reaches first.
  async markAsSent() {
    const before = this.page.url();
    await this.page.locator('#sent-btn').click();
    try {
      await this.page.waitForFunction((previous) => {
        if (location.href !== previous) return true;
        const status = document.getElementById('status-text')?.textContent?.trim();
        const err = document.getElementById('mark-err');
        return status === 'Observing' || Boolean(err && err.textContent.trim());
      }, before, { timeout: this.config.timeouts.control });
    } catch {
      return { ok: false, error: 'Mark as sent produced no confirmation before the timeout' };
    }
    if (this.page.url() !== before) return { ok: true, advanced: true };
    const error = (await this.page.locator('#mark-err').innerText().catch(() => '')).trim();
    const status = (await this.page.locator('#status-text').innerText().catch(() => '')).trim();
    if (status === 'Observing') return { ok: true, advanced: false, warning: error || '' };
    return { ok: false, error: error || 'Mark as sent did not reach Observing' };
  }

  // STEP 3's skip path — the existing Skip agency workflow, reason select and
  // confirm() dialog included. It hard-deletes an unworked AGENCIES row, so it
  // is only ever called for a verified, unambiguous ineligibility.
  async skipAgency(reason) {
    await this.page.locator('#skip-reason').selectOption({ label: reason }).catch(async () => {
      await this.page.locator('#skip-reason').selectOption(reason);
    });
    this.page.once('dialog', (dialog) => dialog.accept().catch(() => {}));
    const before = this.page.url();
    await this.page.locator('#skip-btn').click();
    try {
      await this.page.waitForFunction((previous) => {
        if (location.href !== previous) return true;
        const err = document.getElementById('create-err');
        return Boolean(err && err.textContent.trim());
      }, before, { timeout: this.config.timeouts.control });
    } catch {
      return { ok: false, error: 'Skip agency produced no confirmation before the timeout' };
    }
    if (this.page.url() !== before) return { ok: true };
    const error = (await this.page.locator('#create-err').innerText().catch(() => '')).trim();
    return { ok: false, error: error || 'Skip agency did not complete' };
  }

  async queueRemaining() {
    const text = await this.page.locator('#p-remaining').innerText().catch(() => '');
    const n = Number(String(text).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && text.trim() !== '—' ? n : null;
  }
}

export { dismissCookieBanner };
