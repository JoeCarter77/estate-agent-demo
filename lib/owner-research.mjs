// lib/owner-research.mjs — WHO is the owner/senior decision-maker at an agency.
//
// DELIBERATELY SEPARATE from email finding (lib/hunter.mjs) and from the
// resolver (lib/contact-resolution.mjs). This module answers one question —
// "which named human runs this agency?" — and answers it from web research
// only. It never looks for an address, never verifies one, and never writes to
// the workbook; the resolver owns both of those. That separation is the point:
// the research strategy here is expected to be replaced/improved (better
// sources, Companies House API, a scraper) without touching the resolver.
//
// EVIDENCE OR NOTHING. The model is instructed to return no person at all
// rather than the first plausible name it sees. A result is only accepted when
// it names the source it came from and asserts the person is currently at THIS
// company. An inconclusive answer is a normal, expected outcome — the resolver
// then falls back to existing human contacts and generic inboxes and marks the
// agency NEEDS_RESEARCH.

import { callAi } from './ai-client.mjs';

// Seniority ranking. Lower is better; mirrors the resolver's recipient
// priority so a researched person lands in the right waterfall tier.
export const ROLE_RANK = {
  OWNER: 1,
  FOUNDER: 1,
  MANAGING_DIRECTOR: 2,
  DIRECTOR: 3,
  PARTNER: 3,
  BRANCH_MANAGER: 4,
};

const ACCEPTED_ROLES = Object.keys(ROLE_RANK);

// The search patterns the research step is told to run. Exported so tests and
// future non-AI implementations use exactly the same query set.
export function ownerSearchQueries(agencyName) {
  const name = String(agencyName || '').trim();
  if (!name) return [];
  return [
    `"${name}" owner`,
    `"${name}" founder`,
    `"${name}" managing director`,
    `"${name}" director`,
    `"${name}" partner`,
  ];
}

const OWNER_RESEARCH_TOOL = {
  name: 'record_owner_research',
  description: 'Record the owner or most senior decision-maker identified for this estate agency, or record that the research was inconclusive.',
  input_schema: {
    type: 'object',
    properties: {
      found: {
        type: 'boolean',
        description: 'True ONLY if a specific named person was identified with credible evidence that they currently hold a senior role at THIS agency. False otherwise.',
      },
      person_name: { type: 'string', description: 'Full name of the person, or empty string if found is false.' },
      role: {
        type: 'string',
        enum: [...ACCEPTED_ROLES, 'NONE'],
        description: 'The seniority category of the role held. NONE if found is false.',
      },
      role_title: { type: 'string', description: 'The role exactly as the source states it, e.g. "Managing Director". Empty if found is false.' },
      evidence: { type: 'string', description: 'One or two sentences stating what the source said and why it is credible for THIS company.' },
      source_url: { type: 'string', description: 'The single best URL supporting this, or empty string.' },
      source_type: {
        type: 'string',
        enum: ['AGENCY_WEBSITE', 'COMPANIES_HOUSE', 'BUSINESS_PROFILE', 'INDUSTRY_NEWS', 'OTHER', 'NONE'],
        description: 'Where the evidence came from.',
      },
      confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Confidence that this person is correct and current.' },
    },
    required: ['found', 'person_name', 'role', 'role_title', 'evidence', 'source_url', 'source_type', 'confidence'],
  },
};

const SYSTEM = [
  'You identify the owner or most senior decision-maker of a UK estate agency, using web search.',
  '',
  'Rules you must follow:',
  '- Do NOT accept the first plausible name you see. Corroborate before you report.',
  '- Prefer, in order: the agency\'s own website (About/Team/Meet the team pages), Companies House or reliable Companies House-derived data, credible business/company profiles, reputable property-industry or local news.',
  '- The person must be associated with THIS company: check the town/branch, the domain and the trading name. Similar names are common in this industry; a different company with a similar name is not a match.',
  '- Reject stale evidence (someone who has since left, a dissolved company, an article many years old with no corroboration).',
  '- Prefer seniority in this order: Owner/Founder, Managing Director, Director/Partner, Branch Manager.',
  '- If you cannot meet this bar, set found=false. An honest "not found" is the correct and expected answer; an invented or unverified person is a serious failure.',
].join('\n');

function buildPrompt({ agencyName, domain, website, location }) {
  const lines = [
    `Agency name: ${agencyName}`,
    domain ? `Domain: ${domain}` : null,
    website ? `Website: ${website}` : null,
    location ? `Location: ${location}` : null,
    '',
    'Run searches along these lines (adapt as needed):',
    ...ownerSearchQueries(agencyName).map((q) => `  ${q}`),
    '',
    'Then record the single best-supported senior decision-maker, or found=false.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// Normalises and gates the model's answer. Anything that fails the bar becomes
// an inconclusive result rather than an error — the caller always gets the same
// shape: { found, person_name, role, role_title, evidence, source_url,
// source_type, confidence, rank }.
export function acceptResearchResult(raw) {
  const inconclusive = {
    found: false, person_name: '', role: '', role_title: '',
    evidence: '', source_url: '', source_type: '', confidence: '', rank: null,
  };
  if (!raw || raw.found !== true) return inconclusive;

  const personName = String(raw.person_name || '').trim();
  const role = String(raw.role || '').trim().toUpperCase();
  // A name must look like a person (at least a forename and a surname) and the
  // role must be one we actually rank. Otherwise we have not identified anyone.
  if (personName.split(/\s+/).filter(Boolean).length < 2) return inconclusive;
  if (!ROLE_RANK[role]) return inconclusive;
  // Evidence is the whole point: no stated source, no saved person.
  const sourceUrl = String(raw.source_url || '').trim();
  const evidence = String(raw.evidence || '').trim();
  if (!evidence || !sourceUrl) return inconclusive;
  if (String(raw.confidence || '').trim().toUpperCase() === 'LOW') return inconclusive;

  return {
    found: true,
    person_name: personName,
    role,
    role_title: String(raw.role_title || '').trim() || role.replace(/_/g, ' ').toLowerCase(),
    evidence,
    source_url: sourceUrl,
    source_type: String(raw.source_type || 'OTHER').trim().toUpperCase(),
    confidence: String(raw.confidence || 'MEDIUM').trim().toUpperCase(),
    rank: ROLE_RANK[role],
  };
}

let _researcherOverride = null;

// Test-only: replace the researcher entirely (no network, no AI, no search).
export function __setOwnerResearcherForTests(fn) { _researcherOverride = fn; }

// agency: the AGENCIES row object. Returns the accepted-or-inconclusive shape
// above. Never throws for a research failure — a failed lookup is inconclusive.
export async function researchOwner(agency, { aiCaller = callAi } = {}) {
  const agencyName = String(agency?.agency_name || '').trim();
  if (!agencyName) return acceptResearchResult(null);

  if (_researcherOverride) {
    try {
      return acceptResearchResult(await _researcherOverride(agency));
    } catch (err) {
      console.error('owner research (stub) failed:', err);
      return acceptResearchResult(null);
    }
  }

  try {
    const raw = await aiCaller({
      system: SYSTEM,
      prompt: buildPrompt({
        agencyName,
        domain: String(agency?.domain || '').trim(),
        website: String(agency?.website || '').trim(),
        location: String(agency?.location || '').trim(),
      }),
      tool: OWNER_RESEARCH_TOOL,
      serverTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      purpose: 'owner_research',
    });
    return acceptResearchResult(raw);
  } catch (err) {
    // Search unavailable, model error, malformed result — all the same to the
    // caller: we did not identify anyone.
    console.error('owner research failed:', err);
    return acceptResearchResult(null);
  }
}

export const _internal = { OWNER_RESEARCH_TOOL, SYSTEM, buildPrompt };
