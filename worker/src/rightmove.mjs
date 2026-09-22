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

  const ready = await page.locator('#email').first().isVisible({ timeout: 20000 }).catch(() => false);
  if (!ready) {
    const challenge = await detectChallenge(page);
    if (challenge) return { ok: false, challenge };
    return { ok: false, reason: `the enquiry form did not appear (now at ${page.url()})` };
  }
  return { ok: true, url: page.url() };
}

// STEP 7 — verify the form carries the approved identity and the approved
// seller signal. Nothing is invented: a field the session did not already
// supply is filled from the SAME configured probe identity that the existing
// probe-create endpoint stamps onto the PROBES row. Anything that disagrees
// with that identity is a hard stop, not an overwrite.
export async function verifyAndPrepareEnquiry(page, { identity, propertyId }) {
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
  if (conflicts.length) return { ok: false, reason: 'enquiry form does not match the approved probe identity', conflicts, before };

  // The form belongs to the property we chose.
  if (propertyId && before.propertyId && before.propertyId !== propertyId) {
    return { ok: false, reason: `the enquiry form is for property ${before.propertyId}, not ${propertyId}`, before };
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
  const selling = page.locator('#sellingSituationType');
  if (await selling.count()) {
    await selling.selectOption(SELLING_SITUATION_NOT_ON_MARKET);
  } else {
    return { ok: false, reason: 'the enquiry form has no seller-situation field — its layout is not the approved one', before };
  }

  // A free valuation is a DIFFERENT commercial signal and is deliberately not
  // part of the approved enquiry. Leave it alone; refuse if it arrives ticked.
  const valuation = page.locator('#valuationRequested');
  if (await valuation.count() && await valuation.isChecked()) {
    return { ok: false, reason: 'the form arrived with "Get a free valuation" already ticked, which is not the approved enquiry', before };
  }

  const after = await readEnquiryForm(page);
  const ok = after.email === identity.email
    && after.firstName === identity.firstName
    && after.lastName === identity.lastName
    && digits(after.phone) === digits(identity.phone)
    && after.sellingSituation === SELLING_SITUATION_NOT_ON_MARKET
    && after.valuationRequested === false;
  if (!ok) return { ok: false, reason: 'the enquiry form did not hold the approved values after filling', before, after };
  return { ok: true, before, after };
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
export async function submitEnquiry(page, { timeout }) {
  const submit = page.locator('button[data-testid="submitButton"]').first();
  const fallback = page.getByRole('button', { name: /^Send email$/i }).first();
  const button = (await submit.count()) ? submit : fallback;
  if (!(await button.count())) return { outcome: 'failed', detail: 'no submit control on the enquiry form' };

  await button.click();

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const challenge = await detectChallenge(page);
    if (challenge) return { outcome: 'challenge', challenge };

    const verdict = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      if (/your (enquiry|email|message) (has been |was )?sent|thanks? for (your )?(enquiry|getting in touch)|we've sent your (enquiry|details)|email sent/i.test(text)) {
        return { kind: 'sent', snippet: text.slice(0, 200) };
      }
      // A validation failure keeps the form on screen with visible errors: the
      // enquiry demonstrably did not leave.
      const errors = [...document.querySelectorAll('[class*="error"], [role="alert"], .form-error')]
        .map((el) => (el.innerText || '').trim()).filter(Boolean);
      const formStillThere = Boolean(document.querySelector('#email'));
      if (formStillThere && errors.length) return { kind: 'failed', snippet: errors.join(' | ').slice(0, 300) };
      if (!formStillThere) return { kind: 'gone', snippet: text.slice(0, 200) };
      return null;
    }).catch(() => null);

    if (verdict?.kind === 'sent') return { outcome: 'sent', detail: verdict.snippet };
    if (verdict?.kind === 'failed') return { outcome: 'failed', detail: verdict.snippet };
    // The form disappearing without a confirmation is exactly the ambiguous
    // case the spec calls out: the enquiry may well have gone.
    if (verdict?.kind === 'gone') return { outcome: 'uncertain', detail: `the form left the page without a confirmation message: ${verdict.snippet}` };

    await page.waitForTimeout(500);
  }
  return { outcome: 'uncertain', detail: 'no confirmation and no error appeared before the timeout' };
}
