// lib/enquiry.mjs — parses PROBES.enquiry_text into the structured set of
// things the enquiry actually ASKED FOR.
//
// Why this exists: the pipeline previously read enquiry_text exactly once, for
// exactly one thing — a single regex looking for the vendor declaration
// (lib/vendor-intent.mjs). Everything else downstream analysed the agency's
// communications in isolation, with no idea what the enquiry had asked. That
// makes "did the agency respond to the actual enquiry?" and "what did the
// agency NOT do?" unanswerable questions: you cannot detect a miss without
// knowing what there was to hit.
//
// The real enquiry_text (confirmed against the live workbook, 37 of 39 probes
// share this exact form) is:
//   "Rightmove property enquiry. Declared: has a property to sell, yes, it is
//    not yet on the market; wants more details on this property."
// and one deliberately-compromised probe carries:
//   "... Declared: wants more details on this property. NO property-to-sell
//    declaration present."
//
// Output is the CHECKLIST the rest of the pipeline measures the agency
// against. No phrase-list growth here: the portal generates this text, so the
// clauses are a small closed set, matched literally.

// Rightmove's own declaration clauses. These are portal-generated, not free
// text written by a person, which is why matching them literally is safe.
const SELL_DECLARATION = /has a property to sell/i;
const EXPLICIT_NO_SELL = /no property-to-sell declaration/i;
const NOT_ON_MARKET = /not yet on the market/i;
const WANTS_DETAILS = /wants more details on this property/i;
const WANTS_VIEWING = /(wants|request(?:ed|ing)?) (?:a )?viewing|arrange a viewing/i;

function toBool(v) { return v === true || v === 'TRUE' || v === 'true'; }

// probe (PROBES row) -> the structured enquiry.
//   has_property_to_sell  the enquirer declared an instruction opportunity
//   not_yet_on_market     ...and it is not yet listed anywhere
//   wants_details         asked for information about the probe property
//   wants_viewing         explicitly asked to view (rare in this portal form —
//                         "wants more details" is the usual Rightmove clause)
//   compromised           PROBES.compromised is TRUE: this probe did not test
//                         what it was supposed to, so conclusions drawn from
//                         it are not comparable with the rest
//   property_address      what the agency should be talking about
export function parseEnquiry(probe) {
  const text = String(probe?.enquiry_text || '');
  const declaredSell = SELL_DECLARATION.test(text) && !EXPLICIT_NO_SELL.test(text);

  return {
    enquiry_text: text,
    has_property_to_sell: declaredSell,
    not_yet_on_market: declaredSell && NOT_ON_MARKET.test(text),
    wants_details: WANTS_DETAILS.test(text),
    wants_viewing: WANTS_VIEWING.test(text),
    compromised: toBool(probe?.compromised),
    compromise_reason: String(probe?.compromise_reason || ''),
    property_address: String(probe?.property_address || ''),
    probe_timestamp: String(probe?.probe_timestamp || ''),
  };
}

// The distinctive address tokens the agency would have to use to show it is
// talking about THIS property rather than sending a generic blast. Street
// names and house identifiers only — the town/postcode/county parts are too
// common to be evidence of anything, and "UNKNOWN — ..." placeholders in the
// recorded address are not evidence at all.
const ADDRESS_NOISE = new Set([
  'flat', 'apt', 'apartment', 'house', 'court', 'road', 'street', 'lane', 'avenue',
  'drive', 'close', 'way', 'walk', 'grove', 'place', 'the', 'and', 'unknown',
  'essex', 'billericay', 'brentwood', 'chelmsford', 'basildon', 'southend',
  'rightmove', 'property', 'bed', 'sale', 'for',
]);

// Only DISTINCTIVE, PURELY ALPHABETIC tokens qualify. Anything containing a
// digit is a postcode fragment or a house number ("cm11", "ss14", "151a") —
// nobody says those out loud on a voicemail or repeats them in a reply, so
// treating their absence as evidence of anything produced pure false
// positives against the live data (four probes were flagged as never
// mentioning the property purely because a voicemail did not recite the
// postcode). Property descriptors are noise for the same reason.
const ADDRESS_DESCRIPTORS = new Set(['terraced', 'detached', 'semi', 'bungalow', 'maisonette', 'retirement', 'freehold', 'leasehold']);

export function addressTokens(propertyAddress) {
  const raw = String(propertyAddress || '');
  // A recorded address that is really a note about not knowing the address
  // carries no matchable tokens.
  if (/^unknown/i.test(raw.trim())) return [];
  return [...new Set(
    raw.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4
        && /^[a-z]+$/.test(t)
        && !ADDRESS_NOISE.has(t)
        && !ADDRESS_DESCRIPTORS.has(t)),
  )];
}
