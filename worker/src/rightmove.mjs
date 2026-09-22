// worker/src/rightmove.mjs — the authorised Rightmove side of the workflow.
//
// Selectors here were read from live Rightmove pages, not guessed. Rightmove
// ships CSS-module class names whose hash suffix changes between deploys
// (propertyCard_propertyType__jwCRZ), so every class selector matches on the
// STABLE PREFIX only. Where a data-test attribute exists it is preferred.
//
// Verified structure:
//   branch page    [data-test="propertyList"], tab strip "Properties for sale (N)
//                  / Properties to rent (N)", cards under
//                  [class^="propertyList_propertyList"], each with
//                  [class^="propertyCard_propertyType"] and an anchor to
//                  /properties/<id>#/?channel=RES_BUY
//   property page  <link rel=canonical> is the clean property URL,
//                  [data-testid="branchName"] names the selling agent,
//                  a "Request details" button opens the enquiry form
//   enquiry form   /property-for-sale/contactBranch.html?...&propertyId=<id>
//                  #firstName #lastName #phone\.number #email #postcode #comments
//                  #sellingSituationType (pr_not_on_mrk = "Yes, it is not yet
//                  on the market" — the approved NOVUS seller signal)
//                  #valuationRequested (must stay unchecked)
//                  button[data-testid="submitButton"] ("Send email")

import { dismissCookieBanner, detectChallenge } from './browser.mjs';

export const SELLING_SITUATION_NOT_ON_MARKET = 'pr_not_on_mrk';

const PROPERTY_ID = /\/properties\/(\d+)/;

export function propertyIdOf(url) {
  const match = PROPERTY_ID.exec(String(url || ''));
  return match ? match[1] : '';
}

export function canonicalPropertyUrl(url) {
  const id = propertyIdOf(url);
  return id ? `https://www.rightmove.co.uk/properties/${id}` : '';
}

function slugOfBranchUrl(url) {
  // .../estate-agents/agent/<Agent-Name>/<Area>-<branchId>.html
  const match = /\/estate-agents\/agent\/([^/]+)\/[^/]*?(\d+)\.html/i.exec(String(url || ''));
  return match ? { agentSlug: decodeURIComponent(match[1]).replace(/-/g, ' '), branchId: match[2] } : null;
}

// STEP 2's verification: the tab that opened really is the agency NOVUS handed
// us, not a stale tab or a redirect to a search page.
export async function verifyBranchPage(page, { branchUrl, agencyName }) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissCookieBanner(page);
  const actual = page.url();
  const expected = slugOfBranchUrl(branchUrl);
  const got = slugOfBranchUrl(actual);
  if (!got) return { ok: false, reason: `the tab is not an agent branch page (${actual})` };
  if (expected && got.branchId !== expected.branchId) {
    return { ok: false, reason: `branch id mismatch — expected ${expected.branchId}, got ${got.branchId}` };
  }
  const heading = (await page.locator('h1').first().innerText().catch(() => '')).trim();
  return { ok: true, heading, branchId: got.branchId, agencyName };
}

// STEP 3 — read the for-sale candidates off the branch page. Pure extraction:
// no judgement is made here, that belongs to suitability.mjs.
export async function readBranchCandidates(page) {
  await page.waitForSelector('[data-test="propertyList"]', { timeout: 20000 }).catch(() => {});
  return page.evaluate(() => {
    // CSS-module names are "<component>_<element>__<hash>". Matching on the
    // double underscore is what separates propertyList_propertyList__KDn02 from
    // its sibling propertyList_propertyListControls__rQG_b, which shares the
    // shorter prefix and would otherwise be picked first.
    const byPrefix = (root, prefix) => [...root.querySelectorAll('[class]')]
      .find((el) => [...el.classList].some((c) => c.startsWith(`${prefix}__`)));
    const list = document.querySelector('[data-test="propertyList"]');
    const tabText = (list?.innerText || '').replace(/\s+/g, ' ');
    const forSale = /Properties for sale \((\d+)\)/i.exec(tabText);
    const toRent = /Properties to rent \((\d+)\)/i.exec(tabText);

    // Anchored on the listing links themselves rather than on a container
    // class, so a renamed wrapper cannot silently produce "no properties" —
    // which would read as an ineligible agency and invite a wrongful skip.
    const seen = new Set();
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="/properties/"]')) {
      const card = anchor.closest('[class*="propertyCard_propertyCard"]')
        || anchor.closest('[class*="propertyCard_"]')
        || anchor.parentElement;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }

    const candidates = cards.map((card) => {
      const anchor = card.querySelector('a[href*="/properties/"]')
        || (card.matches('a[href*="/properties/"]') ? card : null);
      const href = anchor?.href || '';
      const typeEl = byPrefix(card, 'propertyCard_propertyType');
      const addressEl = byPrefix(card, 'propertyCard_address');
      const priceEl = byPrefix(card, 'propertyCard_displayPrice');
      return {
        href,
        channel: (/channel=([A-Z_]+)/.exec(href) || [])[1] || '',
        propertyType: (typeEl?.innerText || '').trim(),
        address: (addressEl?.innerText || '').trim(),
        price: (priceEl?.innerText || '').trim(),
        text: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    }).filter((candidate) => candidate.href);

    return {
      forSaleCount: forSale ? Number(forSale[1]) : null,
      toRentCount: toRent ? Number(toRent[1]) : null,
      lettingsOnly: Boolean(forSale && Number(forSale[1]) === 0 && toRent && Number(toRent[1]) > 0),
      candidates,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000),
    };
  });
}

// STEPS 4 & 5 — open the listing, confirm it belongs to this agency, and take
// the canonical URL from the page itself.
export async function openProperty(page, { agencyName, branchId }) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissCookieBanner(page);
  const challenge = await detectChallenge(page);
  if (challenge) return { ok: false, challenge };

  await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
  const info = await page.evaluate(() => ({
    href: location.href,
    canonical: document.querySelector('link[rel="canonical"]')?.href || '',
    title: document.title,
    heading: document.querySelector('h1')?.innerText?.trim() || '',
    branchName: document.querySelector('[data-testid="branchName"]')?.innerText?.trim() || '',
    agentHref: document.querySelector('[data-testid="agentLink"] a, a[data-testid="agentLink"]')?.href
      || [...document.querySelectorAll('a[href*="/estate-agents/agent/"]')].map((a) => a.href)[0] || '',
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 5000),
  }));

  const url = canonicalPropertyUrl(info.canonical || info.href);
  if (!url) return { ok: false, reason: `no property id in ${info.canonical || info.href}` };

  // Belongs-to-this-agency check. The branch id in the page's own agent link is
  // the strongest available signal; the branch name is the readable fallback.
  const linkedBranch = slugOfBranchUrl(info.agentHref);
  const firstWord = normaliseName(agencyName).split(' ')[0] || '';
  const nameMatches = Boolean(firstWord) && normaliseName(info.branchName).includes(firstWord);
  if (branchId && linkedBranch && linkedBranch.branchId !== branchId) {
    return { ok: false, reason: `listing belongs to branch ${linkedBranch.branchId}, not ${branchId}` };
  }
  if (!branchId && !linkedBranch && !nameMatches) {
    return { ok: false, reason: `could not confirm the listing belongs to ${agencyName}` };
  }
  // "For sale" is asserted from the page title Rightmove generates, which
  // always states the channel ("… for sale in …" / "… to rent in …").
  const isSale = /for sale/i.test(info.title) || /RES_BUY/.test(info.href);
  const isLet = /to rent|to let/i.test(info.title) || /RES_LET/.test(info.href);
  if (isLet && !isSale) return { ok: false, reason: 'the listing is a lettings listing, not a sale' };

  return { ok: true, url, title: info.title, heading: info.heading, branchName: info.branchName, bodyText: info.bodyText };
}

function normaliseName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// STEP 6 — open the enquiry form. Rightmove navigates the same tab to
// contactBranch.html, so this returns the page it navigated to.
export async function openEnquiryForm(page) {
  const trigger = page.getByRole('button', { name: /^Request details$/i }).first();
  const link = page.getByRole('link', { name: /^Request details$/i }).first();
  const target = (await trigger.count()) ? trigger : link;
  if (!(await target.count())) return { ok: false, reason: 'no "Request details" control on the listing' };

  await target.scrollIntoViewIfNeeded().catch(() => {});
  await Promise.all([
    page.waitForURL(/contactBranch|contact-branch|enquiry/i, { timeout: 25000 }).catch(() => {}),
    target.click(),
  ]);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await dismissCookieBanner(page);

  // TWO LAYOUTS. Signed out, Rightmove renders editable inputs (#email and
  // friends). Signed in, it renders the account's details as text with an Edit
  // control and no #email input at all. Waiting only for #email made a
  // perfectly healthy signed-in form look like an unexpected page.
  const ready = await page.waitForFunction(() => {
    const editable = document.querySelector('#email');
    if (editable && editable.offsetParent !== null) return true;
    const send = [...document.querySelectorAll('button')]
      .some((button) => button.matches('[data-testid="submitButton"]')
        || /^send( (email|enquiry|message))?$/i.test((button.innerText || '').trim()));
    return send;
  }, undefined, { timeout: 20000 }).then(() => true).catch(() => false);

  if (!ready) {
    const challenge = await detectChallenge(page);
    if (challenge) return { ok: false, challenge };
    return { ok: false, reason: `the enquiry form did not appear (now at ${page.url()})` };
  }
  return { ok: true, url: page.url(), layout: await detectEnquiryLayout(page) };
}

// Which of the two enquiry layouts is on screen. Decided from the DOM, never
// from an assumption about whether the session is signed in.
export async function detectEnquiryLayout(page) {
  return page.evaluate(() => {
    const email = document.querySelector('#email');
    const usable = email && !email.disabled && !email.readOnly && email.offsetParent !== null;
    if (usable) return 'editable';
    const send = [...document.querySelectorAll('button')]
      .some((button) => button.matches('[data-testid="submitButton"]')
        || /^send( (email|enquiry|message))?$/i.test((button.innerText || '').trim()));
    return send ? 'signed_in' : 'unknown';
  }).catch(() => 'unknown');
}

// The part of the page that IS the enquiry, for the signed-in layout. Anchored
// on the send control so it does not depend on a class name, and widened only
// as far as a form/section/main — never the whole document, or the agent's
// own contact details elsewhere on the page could satisfy the identity check.
function enquiryRegionText(page) {
  return page.evaluate(() => {
    const send = [...document.querySelectorAll('button')]
      .find((button) => button.matches('[data-testid="submitButton"]')
        || /^send( (email|enquiry|message))?$/i.test((button.innerText || '').trim()));
    const region = send?.closest('form, section, main, [class*="contact"], [class*="enquiry"]')
      || send?.parentElement?.parentElement
      || document.body;
    return (region.innerText || '').replace(/\u00a0/g, ' ');
  }).catch(() => '');
}

// STEP 7 — verify the form carries the approved identity and the approved
// seller signal. Nothing is invented: a field the session did not already
// supply is filled from the SAME configured probe identity that the existing
// probe-create endpoint stamps onto the PROBES row. Anything that disagrees
// with that identity is a hard stop, not an overwrite.
export async function verifyAndPrepareEnquiry(page, { identity, propertyId, layout = null }) {
  const actualLayout = layout || await detectEnquiryLayout(page);
  if (actualLayout === 'signed_in') return verifySignedInEnquiry(page, { identity, propertyId });
  if (actualLayout === 'unknown') {
    return { ok: false, layout: 'unknown', reason: 'the enquiry page is neither the editable form nor the signed-in summary' };
  }
  const before = await readEnquiryForm(page);
  const conflicts = [];
  const check = (field, expected, actual) => {
    if (!expected) return;
    const a = normaliseValue(field, actual);
    const e = normaliseValue(field, expected);
    if (a && a !== e) conflicts.push(`${field}: form has "${actual}", approved identity is "${expected}"`);
  };
  check('first name', identity.firstName, before.firstName);
  check('last name', identity.lastName, before.lastName);
  check('email', identity.email, before.email);
  check('phone', identity.phone, before.phone);
  if (conflicts.length) return { ok: false, layout: 'editable', reason: 'enquiry form does not match the approved probe identity', conflicts, before };

  // The form belongs to the property we chose.
  if (propertyId && before.propertyId && before.propertyId !== propertyId) {
    return { ok: false, layout: 'editable', reason: `the enquiry form is for property ${before.propertyId}, not ${propertyId}`, before };
  }

  await page.locator('#firstName').fill(identity.firstName);
  await page.locator('#lastName').fill(identity.lastName);
  await page.locator('#email').fill(identity.email);
  await page.locator('#phone\\.number').fill(identity.phone);
  if (identity.postcode && await page.locator('#postcode').count()) {
    await page.locator('#postcode').fill(identity.postcode);
  }

  // THE SELLER SIGNAL. Fixed, never chosen by the operator and never varied per
  // agency: it is the browser-side twin of the VENDOR_DECLARATION the existing
  // probe-create endpoint writes into PROBES.enquiry_text — "has a property to
  // sell, yes, it is not yet on the market".
  const declaration = await ensureSellerDeclaration(page);
  if (!declaration.ok) return { ok: false, layout: 'editable', reason: declaration.reason, before };

  // A free valuation is a DIFFERENT commercial signal and is deliberately not
  // part of the approved enquiry. Leave it alone; refuse if it arrives ticked.
  const valuation = page.locator('#valuationRequested');
  if (await valuation.count() && await valuation.isChecked()) {
    return { ok: false, layout: 'editable', reason: 'the form arrived with "Get a free valuation" already ticked, which is not the approved enquiry', before };
  }

  const after = await readEnquiryForm(page);
  const ok = after.email === identity.email
    && after.firstName === identity.firstName
    && after.lastName === identity.lastName
    && digits(after.phone) === digits(identity.phone)
    && after.sellingSituation === SELLING_SITUATION_NOT_ON_MARKET
    && after.valuationRequested === false;
  if (!ok) return { ok: false, layout: 'editable', reason: 'the enquiry form did not hold the approved values after filling', before, after };
  return { ok: true, layout: 'editable', before, after };
}

// THE SIGNED-IN LAYOUT. Rightmove shows the account's own name, email and
// telephone as text with an Edit control instead of inputs. There is nothing to
// fill, so this VERIFIES rather than writes — and it does so by looking for the
// configured probe identity in what the page displays, which needs no knowledge
// of Rightmove's class names and cannot be fooled by a renamed wrapper.
//
// Edit is deliberately never clicked. When the details already match there is
// nothing to change, and when they do not, the account on screen is not the
// probe identity — that is an escalation, never something to silently rewrite
// in somebody's Rightmove profile.
export async function verifySignedInEnquiry(page, { identity, propertyId }) {
  const text = await enquiryRegionText(page);
  const shown = {
    emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])],
    phones: [...new Set((text.match(/(?:\+44|0)\s?\d[\d\s()-]{7,}\d/g) || []).map((value) => value.trim()))],
  };
  const conflicts = [];

  const wantEmail = String(identity.email || '').trim().toLowerCase();
  if (wantEmail && !shown.emails.some((value) => value.toLowerCase() === wantEmail)) {
    conflicts.push(shown.emails.length
      ? `email: the signed-in enquiry shows ${shown.emails.join(', ')}, approved identity is "${identity.email}"`
      : `email: the signed-in enquiry shows no email address, approved identity is "${identity.email}"`);
  }

  const wantPhone = digits(identity.phone);
  if (wantPhone && !shown.phones.some((value) => digits(value) === wantPhone)) {
    conflicts.push(shown.phones.length
      ? `telephone: the signed-in enquiry shows ${shown.phones.join(', ')}, approved identity is "${identity.phone}"`
      : `telephone: the signed-in enquiry shows no telephone number, approved identity is "${identity.phone}"`);
  }

  // The name is displayed as free text, so it is matched as a whole name and as
  // its two parts, both case- and spacing-insensitive.
  const flat = text.toLowerCase().replace(/\s+/g, ' ');
  const first = String(identity.firstName || '').trim().toLowerCase();
  const last = String(identity.lastName || '').trim().toLowerCase();
  const nameShown = (first && last && flat.includes(`${first} ${last}`))
    || (first && last && flat.includes(first) && flat.includes(last));
  if (first && last && !nameShown) {
    conflicts.push(`name: the signed-in enquiry does not display "${identity.firstName} ${identity.lastName}"`);
  }

  if (conflicts.length) {
    return { ok: false, layout: 'signed_in', reason: 'the signed-in enquiry does not match the approved probe identity', conflicts, shown };
  }

  const urlPropertyId = new URL(page.url()).searchParams.get('propertyId') || '';
  if (propertyId && urlPropertyId && urlPropertyId !== propertyId) {
    return { ok: false, layout: 'signed_in', reason: `the enquiry form is for property ${urlPropertyId}, not ${propertyId}`, shown };
  }

  const declaration = await ensureSellerDeclaration(page, text);
  if (!declaration.ok) return { ok: false, layout: 'signed_in', reason: declaration.reason, shown };

  const valuation = page.locator('#valuationRequested');
  if (await valuation.count() && await valuation.isChecked()) {
    return { ok: false, layout: 'signed_in', reason: 'the enquiry arrived with "Get a free valuation" already ticked, which is not the approved enquiry', shown };
  }

  return { ok: true, layout: 'signed_in', shown, declaration: declaration.how };
}

// THE SELLER SIGNAL, in either layout. Fixed, never chosen by the operator and
// never varied per agency: the browser-side twin of the VENDOR_DECLARATION the
// existing probe-create endpoint writes into PROBES.enquiry_text — "has a
// property to sell, yes, it is not yet on the market".
//
// Three ways it can be satisfied, in decreasing order of directness. If none of
// them holds, the caller escalates: an enquiry that does not carry the seller
// declaration is not the approved probe and must not be sent.
export async function ensureSellerDeclaration(page, regionText = '') {
  const select = page.locator('#sellingSituationType');
  if (await select.count()) {
    await select.selectOption(SELLING_SITUATION_NOT_ON_MARKET).catch(() => {});
    const value = await select.inputValue().catch(() => '');
    if (value === SELLING_SITUATION_NOT_ON_MARKET) return { ok: true, how: 'select' };
    return { ok: false, reason: `the seller-situation field would not take the approved value (it reads "${value}")` };
  }

  // A select that is present but differently identified: match on the option
  // text Rightmove uses, not on an id.
  const byOption = await page.evaluate((wanted) => {
    for (const element of document.querySelectorAll('select')) {
      const option = [...element.options].find((candidate) => /not yet on the market/i.test(candidate.text));
      if (!option) continue;
      element.value = option.value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { matched: true, value: option.value, wanted };
    }
    return { matched: false };
  }, SELLING_SITUATION_NOT_ON_MARKET).catch(() => ({ matched: false }));
  if (byOption.matched) return { ok: true, how: 'select-by-option-text' };

  // Already declared, and shown back as text — the signed-in summary case.
  if (/not yet on the market/i.test(regionText)) return { ok: true, how: 'displayed' };

  return { ok: false, reason: 'the enquiry carries no "property to sell, not yet on the market" declaration, so it is not the approved probe enquiry' };
}

function digits(value) { return String(value || '').replace(/\D/g, '').replace(/^44/, '0'); }
function normaliseValue(field, value) {
  if (field === 'phone') return digits(value);
  return String(value || '').trim().toLowerCase();
}

export async function readEnquiryForm(page) {
  return page.evaluate(() => {
    const value = (selector) => document.querySelector(selector)?.value ?? '';
    const checked = (selector) => Boolean(document.querySelector(selector)?.checked);
    return {
      firstName: value('#firstName'),
      lastName: value('#lastName'),
      email: value('#email'),
      phone: value('#phone\\.number'),
      postcode: value('#postcode'),
      comments: value('#comments'),
      sellingSituation: value('#sellingSituationType'),
      valuationRequested: checked('#valuationRequested'),
      moreDetailsRequested: checked('#moreDetailsRequested'),
      propertyId: new URLSearchParams(location.search).get('propertyId') || '',
      heading: document.querySelector('h1')?.innerText?.trim() || '',
    };
  });
}

// STEP 8 — submit and wait for a DEFINITIVE result. Three outcomes only:
// sent, failed, uncertain. "The button was clicked" is never a success.
//
// CLICKING AND OBSERVING ARE SEPARATE FUNCTIONS, deliberately. Re-reading the
// page after a CAPTCHA must never be able to press Send a second time, and the
// only way to guarantee that is for the re-read path to have no click in it.

// What Rightmove's confirmation page says. A pure function of what was on
// screen, so it can be tested against real wording without a browser.
//
// Both signals are accepted because the human-CAPTCHA path reaches the
// confirmation by a full navigation: Rightmove's own confirmation URL is as
// good evidence as its confirmation copy, and after a challenge the copy is
// what changes most between variants.
const CONFIRMATION_URL = /contactbranchconfirmation|enquiryconfirmation|enquirysent|confirmation|thank[-_]?you/i;

const CONFIRMATION_TEXT = [
  /your (enquiry|email|message|details) (has|have) been sent/i,
  /your (enquiry|email|message) was sent/i,
  /(enquiry|message|email) sent(?![a-z])/i,
  /we('ve| have) sent your (enquiry|details|message)/i,
  /thanks?[,!]? (for (your |getting in touch)|your (enquiry|message))/i,
  /your (enquiry|message|details) (is|are) on (its|their) way/i,
  /(has|have) been (sent|passed|forwarded) (on )?to/i,
  /we('ve| have) passed your details/i,
];

export function classifySubmissionPage({ url = '', text = '', formStillThere = true, errors = [] }) {
  const flat = String(text).replace(/\s+/g, ' ');

  if (CONFIRMATION_URL.test(String(url))) return { kind: 'sent', snippet: flat.slice(0, 200) };
  const matched = CONFIRMATION_TEXT.find((pattern) => pattern.test(flat));
  if (matched) return { kind: 'sent', snippet: flat.slice(0, 200) };

  // "What happens next" is Rightmove's confirmation heading on some variants,
  // but it is too generic to stand alone — it only counts once the enquiry
  // form itself has gone, which rules out the form page that still offers it.
  if (!formStillThere && /what happens next|we'll be in touch|the agent will/i.test(flat)) {
    return { kind: 'sent', snippet: flat.slice(0, 200) };
  }

  // A validation failure keeps the form on screen with visible errors: the
  // enquiry demonstrably did not leave.
  if (formStillThere && errors.length) return { kind: 'failed', snippet: errors.join(' | ').slice(0, 300) };
  if (!formStillThere) return { kind: 'gone', snippet: flat.slice(0, 200) };
  return { kind: 'pending', snippet: '' };
}

// Read the page as it stands. NO CLICK, EVER. This is what the post-CAPTCHA
// and post-release rechecks call.
export async function readSubmissionPage(page, { layout = 'editable' } = {}) {
  return page.evaluate((mode) => ({
    url: location.href,
    text: (document.body?.innerText || '').replace(/\s+/g, ' '),
    errors: [...document.querySelectorAll('[class*="error"], [role="alert"], .form-error')]
      .map((el) => (el.innerText || '').trim()).filter(Boolean),
    // "Is the enquiry still on screen?" asked in the layout's own terms: the
    // signed-in form has no #email input, and treating its absence as the form
    // vanishing reported every signed-in submission as uncertain.
    formStillThere: mode === 'signed_in'
      ? [...document.querySelectorAll('button')].some((element) => element.matches('[data-testid="submitButton"]')
          || /^send( (email|enquiry|message))?$/i.test((element.innerText || '').trim()))
      : Boolean(document.querySelector('#email')),
  }), layout).catch(() => null);
}

// Poll an already-submitted enquiry for its outcome. Observation only.
export async function observeSubmissionOutcome(page, { timeout, layout = 'editable' }) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const challenge = await detectChallenge(page);
    if (challenge) return { outcome: 'challenge', challenge };

    const seen = await readSubmissionPage(page, { layout });
    if (seen) {
      last = seen;
      const verdict = classifySubmissionPage(seen);
      if (verdict.kind === 'sent') return { outcome: 'sent', detail: verdict.snippet };
      if (verdict.kind === 'failed') return { outcome: 'failed', detail: verdict.snippet };
      // The form disappearing without anything that reads as a confirmation is
      // exactly the ambiguous case: the enquiry may well have gone.
      if (verdict.kind === 'gone') {
        return { outcome: 'uncertain', detail: `the form left the page without a confirmation message: ${verdict.snippet}`, page: seen };
      }
    }
    await page.waitForTimeout(500);
  }
  return { outcome: 'uncertain', detail: 'no confirmation and no error appeared before the timeout', page: last };
}

// Click Send, then observe. The caller is responsible for never calling this
// twice for one agency; the orchestrator and the state file both enforce it.
export async function submitEnquiry(page, { timeout, layout = 'editable' }) {
  const submit = page.locator('button[data-testid="submitButton"]').first();
  // The signed-in layout labels the same control "Send enquiry" on some
  // variants, so the fallback matches the family rather than one exact string.
  const fallback = page.getByRole('button', { name: /^Send( (email|enquiry|message))?$/i }).first();
  const button = (await submit.count()) ? submit : fallback;
  if (!(await button.count())) return { outcome: 'failed', detail: 'no submit control on the enquiry form' };

  await button.click();
  return observeSubmissionOutcome(page, { timeout, layout });
}
