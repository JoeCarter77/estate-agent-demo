// worker/src/browser.mjs — the persistent browser session.
//
// A PERSISTENT CONTEXT, not a fresh incognito browser per run. The approved
// Rightmove enquiry identity, the cookie choice and any My Rightmove sign-in
// live in the profile directory on disk, so the enquiry form arrives filled in
// exactly as it does for a human — and so that when a CAPTCHA appears, the
// human can take over THIS window and finish the very challenge that blocked
// the worker, rather than being handed a different session.
//
// Headed by default for the same reason: the run is meant to be watchable and
// interruptible.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class OperatorBrowser {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.novusPage = null;
    this.preparedNovusPages = new WeakSet();
  }

  async launch() {
    if (this.context) return this.context;
    fs.mkdirSync(this.config.profileDir, { recursive: true });
    const frontmost = process.platform === 'darwin' ? frontmostPid() : 0;
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: this.config.headless,
      channel: this.config.channel || undefined,
      viewport: { width: 1440, height: 950 },
      // The NOVUS pages sit behind the same Basic Auth the middleware enforces,
      // so hand Playwright the credential once instead of intercepting 401s.
      httpCredentials: this.config.basicAuthUser
        ? { username: this.config.basicAuthUser, password: this.config.basicAuthPass }
        : undefined,
      acceptDownloads: false,
    });
    // NOVUS pages now send people to a login page instead of challenging for
    // Basic Auth (middleware.js), so the worker presents its admin machine
    // credential up front — ONLY on the NOVUS origin, never to agency sites —
    // with the X-NOVUS-Client marker middleware requires on page requests.
    if (this.config.basicAuthUser && this.config.novusBaseUrl) {
      const origin = new URL(this.config.novusBaseUrl).origin;
      const authorization = `Basic ${Buffer.from(`${this.config.basicAuthUser}:${this.config.basicAuthPass}`).toString('base64')}`;
      await this.context.route((u) => u.origin === origin, (route) => route.continue({
        headers: { ...route.request().headers(), authorization, 'x-novus-client': 'worker' },
      }));
    }
    this.context.setDefaultTimeout(this.config.timeouts.control);
    this.context.setDefaultNavigationTimeout(this.config.timeouts.nav);
    // Chrome can activate on its first launch. Return focus to the application
    // the operator was using; subsequent tabs are created in the background.
    if (frontmost && frontmost !== this.chromePid()) activatePid(frontmost);
    return this.context;
  }

  chromePid() {
    if (process.platform !== 'darwin') return 0;
    try {
      const lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
      const profile = `--user-data-dir=${this.config.profileDir}`;
      const line = lines.find((entry) => entry.includes(profile) && !entry.includes('--type='));
      return Number(line?.trim().split(/\s+/, 1)[0]) || 0;
    } catch { return 0; }
  }

  async focusInterventionTab(current = {}) {
    const tabs = this.rightmoveTabs();
    const propertyId = /\/properties\/(\d+)/.exec(current.property_url || '')?.[1];
    const page = (propertyId && tabs.find((tab) => tab.url().includes(`propertyId=${propertyId}`)
      || tab.url().includes(`/properties/${propertyId}`)))
      || tabs.find((tab) => tab.url().split('#')[0] === (current.branch_url || '').split('#')[0])
      || tabs.at(-1) || await this.novusTab();
    await page.bringToFront(); // Only a notification click may do this.
    const pid = this.chromePid();
    if (pid) activatePid(pid);
  }

  // CDP's background target avoids the foreground activation caused by
  // window.open and Playwright's newPage. The page stays in the same persistent
  // context, with the same Rightmove login and normal Playwright control.
  async openBackgroundTab(url) {
    await this.launch();
    const anchor = await this.novusTab();
    const before = new Set(this.context.pages());
    const cdp = await this.context.newCDPSession(anchor);
    // Start blank: an initial URL passed to Target.createTarget can navigate
    // before Playwright's context routing is attached (including the test's
    // live-Rightmove blockade). Navigate only through the attached Page.
    try { await cdp.send('Target.createTarget', { url: 'about:blank', background: true }); }
    finally { await cdp.detach(); }
    const deadline = Date.now() + this.config.timeouts.nav;
    while (Date.now() < deadline) {
      const page = this.context.pages().find((candidate) => !before.has(candidate) && !candidate.isClosed());
      if (page) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Background tab did not open: ${url}`);
  }

  async close() {
    if (!this.context) return;
    try { await this.context.close(); } finally { this.context = null; this.novusPage = null; }
  }

  // The NOVUS Prober tab is long-lived and is never closed by the workflow:
  // step 10 returns to it. Rightmove tabs come and go around it.
  async novusTab() {
    await this.launch();
    if (this.novusPage && !this.novusPage.isClosed()) return this.novusPage;
    const existing = this.context.pages().find((page) => !page.isClosed());
    this.novusPage = existing || (await this.context.newPage());
    if (!this.preparedNovusPages.has(this.novusPage)) {
      // The existing Prober auto-opens a branch tab. Only in this worker tab,
      // suppress that popup; acquireBranchTab opens the same URL in a Chrome
      // background target. The manual Prober remains untouched.
      await this.novusPage.addInitScript(() => {
        const original = window.open.bind(window);
        window.open = (url, ...args) => /rightmove\.co\.uk\/estate-agents\/agent\//i.test(String(url || ''))
          ? null : original(url, ...args);
      });
      this.preparedNovusPages.add(this.novusPage);
    }
    return this.novusPage;
  }

  rightmoveTabs() {
    if (!this.context) return [];
    return this.context.pages().filter((page) => !page.isClosed()
      && page !== this.novusPage
      && /rightmove\.co\.uk/i.test(page.url()));
  }

  // STEP 10's close: every Rightmove tab opened for this probe, and nothing
  // else. The NOVUS tab is excluded by identity, not by URL matching.
  async closeRightmoveTabs() {
    for (const page of this.rightmoveTabs()) {
      try { await page.close(); } catch { /* already gone */ }
    }
  }

  // Click something that opens a tab, and return that tab. Falls back to the
  // popup being blocked or the click navigating in place, which is why the
  // caller always passes the URL it expected: a blocked popup is recovered by
  // opening the page directly rather than abandoning the agency.
  async openInNewTab(trigger, { fallbackUrl = '', timeout = 15000, graceMs = 2500, matches = null } = {}) {
    await this.launch();
    const accept = matches || (() => true);
    const before = new Set(this.context.pages());
    await trigger().catch(() => {});

    // THE TAB IS IDENTIFIED BY WHAT IT IS, NOT BY WHEN IT ARRIVED. Waiting for
    // the next 'page' event returned whichever tab happened to open first —
    // and the Prober opens the agency's branch page with its own window.open
    // as the agency loads, so a late branch tab could be handed back as "the
    // property". openProperty then read the branch page and reported "no
    // property id in <branch url>" for a listing that had opened perfectly
    // well in the tab next to it.
    //
    // So: poll the tab list, skip anything still on about:blank, and return
    // only a tab whose URL is the one that was asked for. Tabs that do not
    // match are left alone; closeRightmoveTabs tidies them up at step 10.
    const deadline = Date.now() + timeout;
    let sawNewTab = false;
    while (Date.now() < deadline) {
      for (const page of this.context.pages()) {
        if (before.has(page) || page.isClosed()) continue;
        sawNewTab = true;
        const url = page.url();
        if (!url || url === 'about:blank') continue;     // still navigating
        if (!accept(url)) continue;                      // somebody else's tab
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return { page, recovered: false };
      }
      // Nothing opened at all within the grace period: the popup was blocked,
      // which is recovered below rather than waited out.
      if (!sawNewTab && Date.now() - (deadline - timeout) > graceMs) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    if (fallbackUrl) {
      const page = await this.context.newPage();
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' });
      return { page, recovered: true };
    }
    return { page: null, recovered: false };
  }

  async screenshotBase64(page) {
    try {
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      return buffer.toString('base64');
    } catch { return ''; }
  }

  // A screenshot AND the page's own HTML. When an enquiry layout is refused,
  // the screenshot says what the human saw and the HTML says what the operator
  // saw — which is what is actually needed to teach it a new layout.
  async saveFormEvidence(page, name) {
    const shot = await this.saveEvidence(page, name);
    try {
      fs.mkdirSync(this.config.evidenceDir, { recursive: true });
      const file = path.join(this.config.evidenceDir, `${Date.now()}-${name.replace(/[^a-z0-9._-]/gi, '_')}.html`);
      fs.writeFileSync(file, await page.content());
      return file;
    } catch { return shot; }
  }

  // Evidence for step 8 ("record evidence of success") and for any escalation.
  async saveEvidence(page, name) {
    try {
      fs.mkdirSync(this.config.evidenceDir, { recursive: true });
      const file = path.join(this.config.evidenceDir, `${Date.now()}-${name.replace(/[^a-z0-9._-]/gi, '_')}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch { return ''; }
  }
}

function frontmostPid() {
  try {
    const code = 'function run() { ObjC.import("AppKit"); return $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier; }';
    return Number(execFileSync('osascript', ['-l', 'JavaScript', '-e', code], { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
}

function activatePid(pid) {
  try {
    const code = `function run() { ObjC.import("AppKit"); return $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(0); }`;
    execFileSync('osascript', ['-l', 'JavaScript', '-e', code], { stdio: 'ignore' });
  } catch { /* focus restoration is best effort */ }
}

// CAPTCHA / verification detection. Deterministic first — a visible reCAPTCHA
// challenge frame, a Cloudflare interstitial or an explicit "verify you are
// human" heading are all unambiguous and cost nothing to spot. Only a page
// that is unexpected AND does not match any of these reaches the model.
export async function detectChallenge(page) {
  try {
    const found = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 40 && rect.height > 40 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      // reCAPTCHA renders its interactive challenge in a bframe iframe. The
      // invisible badge anchor frame is always present and is NOT a challenge.
      const challengeFrame = [...document.querySelectorAll('iframe[src*="recaptcha"]')]
        .find((frame) => /bframe/.test(frame.src) && visible(frame.parentElement?.parentElement || frame));
      if (challengeFrame) return { kind: 'captcha', detail: 'reCAPTCHA challenge frame is visible' };
      if (document.querySelector('iframe[src*="hcaptcha"], .h-captcha, #challenge-form, #cf-challenge-running')) {
        return { kind: 'captcha', detail: 'bot-verification challenge element present' };
      }
      const text = (document.body?.innerText || '').slice(0, 3000);
      if (/verify (that )?you (are|'re) (a )?human|are you a robot|unusual traffic|checking your browser/i.test(text)) {
        return { kind: 'verification_challenge', detail: 'page asks for human verification' };
      }
      if (/sign in to continue|your session has expired|please log in again/i.test(text)) {
        return { kind: 'login_required', detail: 'the session appears to have expired' };
      }
      return null;
    });
    return found;
  } catch {
    return null;
  }
}

// Rightmove's OneTrust banner. Declining non-essential cookies is the
// privacy-preserving choice and it is a stable, deterministic control. Done
// once per profile; afterwards the banner never appears again.
export async function dismissCookieBanner(page) {
  try {
    const reject = page.locator('#onetrust-reject-all-handler');
    if (await reject.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reject.click({ timeout: 3000 });
      await page.waitForTimeout(400);
      return 'rejected';
    }
  } catch { /* no banner */ }
  return 'absent';
}
