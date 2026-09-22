// worker/src/suitability.mjs — deterministic property suitability, no model.
//
// Rightmove labels every card on an agent's branch page with a property type
// ("Flat", "House", "Land", "Commercial Property") and links it with an
// explicit channel (RES_BUY, RES_LET, COM_BUY). Those two facts decide almost
// every case outright, for free and identically every time. The model in
// ../src/ai.mjs is only reached when this file returns 'uncertain'.

const RESIDENTIAL = [
  'house', 'flat', 'apartment', 'bungalow', 'maisonette', 'terraced', 'semi-detached',
  'detached', 'town house', 'townhouse', 'cottage', 'penthouse', 'duplex', 'studio',
  'mews', 'end of terrace', 'link detached', 'barn conversion', 'chalet', 'villa',
  'character property', 'country house', 'farm house', 'farmhouse', 'lodge',
];

// Matched against the PROPERTY TYPE label only. Short words like "land" and
// "plot" are decisive there and ambiguous anywhere else.
const NOT_RESIDENTIAL_SALE = [
  'land', 'plot', 'commercial', 'office', 'retail', 'industrial', 'warehouse',
  'garage', 'parking', 'block of apartments', 'hotel', 'restaurant', 'pub',
  'leisure', 'farm land', 'site', 'investment', 'shop',
  'business', 'house share', 'room',
];

// Matched against the whole card, where only unambiguous multi-word phrases are
// safe: "bedroom" contains "room", and a description mentioning "development"
// is not a development site.
const NOT_RESIDENTIAL_IN_TEXT = [
  'commercial property', 'development site', 'building plot', 'land for sale',
  'garage for sale', 'parking space', 'block of apartments', 'house share',
];

// Residential in shape, but a probe on one is not a normal seller enquiry.
const AVOID_IF_ALTERNATIVE_EXISTS = ['retirement', 'shared ownership', 'auction', 'park home', 'houseboat'];

function norm(value) { return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

export function classifyPropertyType(propertyType, extraText = '') {
  const type = norm(propertyType);
  const blob = `${type} ${norm(extraText)}`;

  if (!type && !norm(extraText)) return { verdict: 'uncertain', category: 'unknown', reason: 'no property type shown on the card' };

  const banned = NOT_RESIDENTIAL_SALE.find((word) => type.includes(word))
    || NOT_RESIDENTIAL_IN_TEXT.find((phrase) => blob.includes(phrase));
  if (banned) {
    const category = /development/.test(banned) ? 'new_build_development'
      : /land|plot|site/.test(banned) ? 'land'
      : /commercial|office|retail|industrial|warehouse|shop|business|hotel|restaurant|pub|leisure/.test(banned) ? 'commercial'
      : 'unknown';
    return { verdict: 'unsuitable', category, reason: `listing is described as "${banned}"` };
  }

  const match = RESIDENTIAL.find((word) => type.includes(word));
  if (!match) return { verdict: 'uncertain', category: 'unknown', reason: `unrecognised property type "${propertyType}"` };

  const caution = AVOID_IF_ALTERNATIVE_EXISTS.find((word) => blob.includes(word));
  return {
    verdict: 'suitable',
    category: 'residential_sale',
    reason: `ordinary residential ${match} for sale`,
    deprioritised: Boolean(caution),
    deprioritised_reason: caution || '',
  };
}

// Rank the candidates a branch page offered. Deterministic and stable: plain
// residential first, cautious residential (retirement, auction, shared
// ownership) only if nothing better exists, and never an unsuitable one.
export function chooseListing(candidates) {
  const scored = candidates.map((candidate) => ({
    candidate,
    assessment: classifyPropertyType(candidate.propertyType, candidate.text),
  }));
  const suitable = scored.filter((row) => row.assessment.verdict === 'suitable');
  const plain = suitable.filter((row) => !row.assessment.deprioritised);
  const pick = plain[0] || suitable[0] || null;
  return {
    chosen: pick ? pick.candidate : null,
    assessment: pick ? pick.assessment : null,
    uncertain: scored.filter((row) => row.assessment.verdict === 'uncertain').map((row) => row.candidate),
    all: scored,
  };
}
