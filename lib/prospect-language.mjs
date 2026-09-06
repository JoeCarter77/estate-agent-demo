// Plain-language boundary for prose that can reach a prospect or demo.

export const INTERNAL_PROSPECT_LANGUAGE_RE = /\b(?:observation window|evidence window|recorded period|intelligence row|structured signals?|source type|unresolved context|dual-sided lead|several signals|probe|findings?|diagnosis|classification|pipeline)\b/i;

const REPLACEMENTS = [
  [/\bobservation window\b/gi, 'period after the enquiry'],
  [/\bevidence window\b/gi, 'period after the enquiry'],
  [/\brecorded period\b/gi, 'period after the enquiry'],
  [/\bintelligence row\b/gi, 'available information'],
  [/\bstructured signals?\b/gi, 'useful details'],
  [/\bsource type\b/gi, 'source'],
  [/\bunresolved context\b/gi, 'open questions'],
  [/\bdual-sided lead\b/gi, 'enquiry'],
  [/\bseveral signals\b/gi, 'useful details'],
  [/\bprobe\b/gi, 'enquiry'],
  [/\bfindings?\b/gi, 'details'],
  [/\bdiagnosis\b/gi, 'review'],
  [/\bclassification\b/gi, 'description'],
  [/\bpipeline\b/gi, 'process'],
];

export function rewriteInternalProspectLanguage(value, { periodPhrase = 'the period after the enquiry' } = {}) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/\b(?:during|within|in)\s+(?:the\s+)?(?:observation window|evidence window|recorded period)\b/gi, periodPhrase);
  text = text.replace(/\b(?:observation window|evidence window|recorded period)\b/gi, periodPhrase);
  for (const [pattern, replacement] of REPLACEMENTS.slice(3)) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
}

export function containsInternalProspectLanguage(value) {
  return INTERNAL_PROSPECT_LANGUAGE_RE.test(String(value ?? ''));
}

export function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function numberWord(value) {
  return ({ 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven' })[value] || String(value);
}

export function enquiryPeriodPhrase(probe, { firstPerson = false } = {}) {
  const start = Date.parse(probe?.probe_timestamp || '');
  const end = Date.parse(probe?.observation_deadline || '');
  // Historical probes predate the explicit deadline column, but their fixed
  // review period was still four days. Preserve that real duration rather
  // than falling back to vague wording.
  if (Number.isFinite(start) && !Number.isFinite(end)) {
    return firstPerson ? 'In the four days after I sent the enquiry' : 'in the four days after the enquiry';
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return firstPerson ? 'After I sent the enquiry' : 'after the enquiry';
  }
  const minutes = Math.round((end - start) / 60000);
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return firstPerson
      ? `In the ${numberWord(days)} days after I sent the enquiry`
      : `in the ${numberWord(days)} days after the enquiry`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return firstPerson
      ? `In the ${numberWord(hours)} hours after I sent the enquiry`
      : `in the ${numberWord(hours)} hours after the enquiry`;
  }
  return firstPerson
    ? `In the ${minutes} minutes after I sent the enquiry`
    : `in the ${minutes} minutes after the enquiry`;
}
