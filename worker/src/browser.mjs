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

export class OperatorBrowser {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.novusPage = null;
  }

  async launch() {
    if (this.context) return this.context;
    fs.mkdirSync(this.config.profileDir, { recursive: true });
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
    this.context.setDefaultTimeout(this.config.timeouts.control);
    this.context.setDefaultNavigationTimeout(this.config.timeouts.nav);
    return this.context;
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
  async openInNewTab(trigger, { fallbackUrl = '', timeout = 15000 } = {}) {
    await this.launch();
    const before = new Set(this.context.pages());
    let popup = null;
    try {
      const waiter = this.context.waitForEvent('page', { timeout });
      await trigger();
      popup = await waiter;
    } catch {
      popup = this.context.pages().find((page) => !before.has(page)) || null;
    }
    if (!popup && fallbackUrl) {
      popup = await this.context.newPage();
      await popup.goto(fallbackUrl, { waitUntil: 'domcontentloaded' });
      return { page: popup, recovered: true };
    }
    if (!popup) return { page: null, recovered: false };
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    return { page: popup, recovered: false };
  }

  async screenshotBase64(page) {
    try {
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      return buffer.toString('base64');
    } catch { return ''; }
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
