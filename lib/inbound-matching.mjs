// Shared deterministic inbound identity/probe matcher.
//
// Agency identifiers and property evidence are resolved independently and
// then reconciled. This module deliberately contains no AI/fuzzy identity
// path: contradictory or non-unique evidence is returned for manual review.
//
// Historical exact identity is deliberately checked first. If the exact same
// normalised sender email/phone has already been resolved to ONE unique
// (agency_id, probe_id) pair, a later communication can safely inherit that
// identity across channels. Shared identifiers that have pointed at more than
// one probe are never guessed.

import { canonicalTimestamp, normalizeEmail, normalizePhone } from './normalize.mjs';

const STREET_SUFFIXES = new Map([
  ['road', 'rd'], ['rd', 'rd'], ['street', 'st'], ['st', 'st'],
  ['avenue', 'ave'], ['ave', 'ave'], ['lane', 'ln'], ['ln', 'ln'],
  ['drive', 'dr'], ['dr', 'dr'], ['close', 'cl'], ['cl', 'cl'],
  ['court', 'ct'], ['ct', 'ct'], ['place', 'pl'], ['pl', 'pl'],
  ['terrace', 'ter'], ['ter', 'ter'], ['boulevard', 'blvd'], ['blvd', 'blvd'],
  ['gardens', 'gdns'], ['garden', 'gdn'], ['way', 'way'], ['crescent', 'cres'], ['cres', 'cres'],
]);

const PRE_PROBE_TOLERANCE_MS = 5 * 60 * 1000;

function list(cell) {
  return String(cell ?? '').split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean);
}

function emailList(cell) {
  return String(cell ?? '').split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean);
}

function setIntersection(sets) {
  if (!sets.length) return new Set();
  return new Set([...sets[0]].filter((value) => sets.slice(1).every((set) => set.has(value))));
}

function exactPhrase(text, phrase) {
  return phrase && (` ${text} `).includes(` ${phrase} `);
}

function text(value) {
  return String(value ?? '').trim();
}

export function normalizePropertyText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((token) => STREET_SUFFIXES.get(token) || token)
    .join(' ');
}

export function extractRightmovePropertyIds(value) {
  const ids = new Set();
  const regex = /(?:https?:\/\/)?(?:www\.)?rightmove\.co\.uk\/properties\/(\d+)/gi;
  for (const match of String(value ?? '').matchAll(regex)) ids.add(match[1]);
  return ids;
}

export function extractUkPhones(value) {
  const phones = new Set();
  const regex = /(?:\+44\s*\(?0?\)?|\b0)(?:[\s().-]*\d){9,10}\b/g;
  for (const match of String(value ?? '').matchAll(regex)) {
    const normalized = normalizePhone(match[0].replace(/^\+44\s*\(?0\)?/, '+44'));
    if (/^\+44\d{9,10}$/.test(normalized)) phones.add(normalized);
  }
  return phones;
}

function postcodeParts(value) {
  const raw = String(value ?? '').toUpperCase();
  const full = raw.match(/\b([A-Z]{1,2}\d[A-Z\d]?)[\s-]*(\d[A-Z]{2})\b/);
  if (full) return { outward: full[1], full: `${full[1]} ${full[2]}` };
  const outward = raw.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b/);
  return { outward: outward?.[1] || '', full: '' };
}

function stripHouseNumber(value) {
  return String(value ?? '')
    .replace(/^\s*(?:(?:flat|apartment|apt|unit)\s+[a-z0-9-]+\s*,?\s*)?/i, '')
    .replace(/^\s*\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?\s*,?\s*/i, '')
    .trim();
}

export function propertyComponents(address) {
  const raw = String(address ?? '').trim();
  const postcode = postcodeParts(raw);
  const components = raw.split(',')
    .map((part) => part.replace(/\b[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\b/gi, '').trim())
    .filter(Boolean);
  if (!components.length) return { street: '', locality: '', town: '', ...postcode };
  const street = normalizePropertyText(stripHouseNumber(components[0]));
  const rest = components.slice(1).map(normalizePropertyText).filter(Boolean);
  return { street, locality: rest[0] || '', town: rest.at(-1) || '', ...postcode };
}

function probeAddressEvidence(probe, normalizedContent, rawContent) {
  const parts = propertyComponents(probe.property_address || probe.property_street);
  if (!parts.street || parts.street.length < 4 || !exactPhrase(normalizedContent, parts.street)) return null;

  const incomingPostcode = postcodeParts(rawContent);
  const outwardMatches = Boolean(parts.outward && incomingPostcode.outward && parts.outward === incomingPostcode.outward);
  const fullMatches = Boolean(parts.full && incomingPostcode.full && parts.full === incomingPostcode.full);
  const localityMatches = Boolean(parts.locality && exactPhrase(normalizedContent, parts.locality));
  const townMatches = Boolean(parts.town && exactPhrase(normalizedContent, parts.town));

  if (outwardMatches && (localityMatches || townMatches)) {
    return { strength: 80 + (fullMatches ? 2 : 0) + (localityMatches && townMatches ? 1 : 0), method: 'property_address_exact', reason: `street=${parts.street}; postcode=${parts.outward}; locality/town` };
  }
  if (outwardMatches) {
    return { strength: 70 + (fullMatches ? 2 : 0), method: 'property_street_postcode', reason: `street=${parts.street}; postcode=${parts.outward}` };
  }
  if (localityMatches || townMatches) {
    return { strength: 60, method: 'property_street_locality', reason: `street=${parts.street}; locality/town` };
  }
  return null;
}

// A probe that is closed NOW was still active when an older communication
// arrived. For retrospective matching, eligibility is therefore determined by
// the stored probe_timestamp -> observation_deadline interval, not the probe's
// current lifecycle status. Draft/compromised rows are still excluded.
function isActiveProbe(probe, at) {
  const status = String(probe.probe_status || '').toLowerCase();
  if (['draft', 'compromised', 'cancelled'].includes(status)) return false;
  const sent = canonicalTimestamp(probe.probe_timestamp);
  const deadline = canonicalTimestamp(probe.observation_deadline);
  if (!sent || !deadline) return false;
  const time = at.getTime();
  return time >= new Date(sent).getTime() - PRE_PROBE_TOLERANCE_MS
    && time <= new Date(deadline).getTime();
}

function agencyPhoneSet(agency) {
  const values = new Set();
  for (const [key, value] of Object.entries(agency)) {
    if (!/phone/i.test(key)) continue;
    for (const phone of extractUkPhones(value)) values.add(phone);
    for (const candidate of list(value)) {
      const normalized = normalizePhone(candidate);
      if (normalized) values.add(normalized);
    }
  }
  return values;
}

function agencyNameMention(agency, content) {
  const haystack = normalizePropertyText(content);
  const name = normalizePropertyText(agency.agency_name);
  if (name.length < 4) return false;
  return ['from', 'calling from', 'this is', 'at'].some((prefix) => exactPhrase(haystack, `${prefix} ${name}`));
}

function explicitProbeContext(input, hasPropertyEvidence) {
  if (hasPropertyEvidence || input.channel === 'voice') return true;
  const content = `${input.subject || ''}\n${input.body_text || ''}\n${input.transcript || ''}`.toLowerCase();
  return /\b(?:your|recent|original)\s+enquir(?:y|ies)\b|\bfollow(?:ing)?\s+up\b|\bviewing\b|\bappointment\b|\bcall(?:\s+\w+){0,2}\s+back\b|\brequested\s+(?:details|information)\b|^\s*re(?:\s*:|\s*$)/m.test(content);
}

function unmatched(evidence, status = 'unmatched', method = 'unmatched', agencyId = '') {
  return { match_status: status, matching_method: method, agency_id: agencyId, probe_id: '', match_score: 0, evidence };
}

function normalizedIdentityFromInput(input) {
  const email = normalizeEmail(input.sender_email || '').normalized;
  if (email) return { type: 'email', value: email };
  const phone = normalizePhone(input.sender_phone || '');
  if (phone && /^\+\d{7,15}$/.test(phone)) return { type: 'phone', value: phone };
  return null;
}

function normalizedIdentityFromCommunication(comm) {
  const explicit = text(comm.source_identifier_normalized);
  if (String(comm.channel || '').toLowerCase() === 'email') {
    return normalizeEmail(explicit || comm.source_identifier_raw || '').normalized;
  }
  if (['sms', 'voice'].includes(String(comm.channel || '').toLowerCase())) {
    return normalizePhone(explicit || comm.source_identifier_raw || '');
  }
  if (explicit.includes('@')) return normalizeEmail(explicit).normalized;
  return normalizePhone(explicit || comm.source_identifier_raw || '');
}

function historicalExactMatch(communications, input, at) {
  const identity = normalizedIdentityFromInput(input);
  if (!identity) return null;
  const atMs = at.getTime();
  const pairs = new Map();
  for (const record of communications || []) {
    const comm = record.obj || record;
    if (String(comm.direction || '').toLowerCase() !== 'inbound') continue;
    if (String(comm.match_status || '').toLowerCase() !== 'matched') continue;
    const agencyId = text(comm.agency_id);
    const probeId = text(comm.probe_id);
    if (!agencyId || !probeId) continue;
    if (normalizedIdentityFromCommunication(comm) !== identity.value) continue;
    const occurredMs = new Date(comm.occurred_at || comm.received_at || 0).getTime();
    // In live ingestion there is no current row yet. During transcript/backfill
    // review the current row can already exist; strict < prevents it teaching
    // itself while still allowing every genuinely earlier resolution.
    if (Number.isFinite(atMs) && Number.isFinite(occurredMs) && occurredMs >= atMs) continue;
    pairs.set(`${agencyId}\u0000${probeId}`, { agency_id: agencyId, probe_id: probeId });
  }
  if (pairs.size !== 1) return { identity, pair: null, ambiguous: pairs.size > 1, count: pairs.size };
  return { identity, pair: [...pairs.values()][0], ambiguous: false, count: 1 };
}

// input fields: channel, sender_email, sender_phone, display_name, subject,
// body_text, raw_content, transcript, agency_id_hint. `at` should be
// communication time for a dry run and current time for live ingestion.
export async function matchInboundCommunication(repo, input = {}, at = new Date()) {
  const [agencyRecords, probeRecords, communicationRecords] = await Promise.all([
    repo.getRecords('AGENCIES', 'agency_id'),
    repo.getRecords('PROBES', 'probe_id'),
    // Some narrow read-only matcher facades used in tests/review may not expose
    // COMMUNICATIONS yet. Treat that as no history rather than breaking the
    // pre-existing matcher contract.
    repo.getRecords('COMMUNICATIONS', 'communication_id').catch(() => []),
  ]);
  const agencies = agencyRecords.map((record) => record.obj);
  const probes = probeRecords.map((record) => record.obj);
  const activeProbes = probes.filter((probe) => isActiveProbe(probe, at));
  const content = [input.display_name, input.subject, input.body_text, input.raw_content, input.transcript].filter(Boolean).join('\n');
  const normalizedContent = normalizePropertyText(content);
  const evidence = [];

  const historical = historicalExactMatch(communicationRecords, input, at);
  if (historical?.pair) {
    evidence.push({
      type: 'historical_identifier', method: 'historical_identifier_exact',
      probe_id: historical.pair.probe_id, agency_id: historical.pair.agency_id,
      detail: `${historical.identity.type}=${historical.identity.value}; unique prior matched pair`,
    });
    return {
      match_status: 'matched', matching_method: 'historical_identifier_exact',
      agency_id: historical.pair.agency_id, probe_id: historical.pair.probe_id,
      match_score: 1, evidence,
    };
  }
  if (historical?.ambiguous) {
    evidence.push({
      type: 'historical_identifier', method: 'historical_identifier_ambiguous',
      detail: `${historical.identity.type}=${historical.identity.value}; ${historical.count} prior matched pairs`,
    });
  }

  const agencySignals = [];
  const addAgencySignal = (type, method, matches, detail) => {
    if (!matches.size) return;
    agencySignals.push({ type, method, matches });
    evidence.push({ type, method, agency_ids: [...matches], detail });
  };

  const agencyHint = text(input.agency_id_hint);
  if (agencyHint) {
    const valid = new Set(agencies.some((agency) => text(agency.agency_id) === agencyHint) ? [agencyHint] : []);
    addAgencySignal('agency_hint', 'existing_agency_id', valid, agencyHint);
  }

  const senderEmail = normalizeEmail(input.sender_email || '');
  if (senderEmail.normalized) {
    const exact = new Set();
    const domains = new Set();
    for (const agency of agencies) {
      const emails = [agency.primary_contact_email, ...emailList(agency.other_known_emails)].map((value) => normalizeEmail(value).normalized).filter(Boolean);
      if (emails.includes(senderEmail.normalized)) exact.add(agency.agency_id);
      if (senderEmail.domain && String(agency.domain || '').trim().toLowerCase() === senderEmail.domain) domains.add(agency.agency_id);
    }
    addAgencySignal('sender_email', 'email_exact', exact, senderEmail.normalized);
    if (!exact.size) addAgencySignal('sender_domain', 'domain_exact', domains, senderEmail.domain);
  }

  const senderPhone = normalizePhone(input.sender_phone || '');
  if (senderPhone && /^\+\d{7,15}$/.test(senderPhone)) {
    const matches = new Set(agencies.filter((agency) => agencyPhoneSet(agency).has(senderPhone)).map((agency) => agency.agency_id));
    addAgencySignal('sender_phone', 'phone_exact', matches, senderPhone);
  }

  const contentPhones = extractUkPhones(content);
  if (contentPhones.size) {
    const matches = new Set();
    for (const agency of agencies) {
      const known = agencyPhoneSet(agency);
      if ([...contentPhones].some((phone) => known.has(phone))) matches.add(agency.agency_id);
    }
    addAgencySignal('content_phone', 'content_phone_exact', matches, [...contentPhones].join(', '));
  }

  const nameMatches = new Set(agencies.filter((agency) => agencyNameMention(agency, content)).map((agency) => agency.agency_id));
  addAgencySignal('agency_name', 'name_content', nameMatches, 'explicit self-identification');

  const rightmoveIds = extractRightmovePropertyIds(content);
  const propertyMatches = [];
  for (const probe of activeProbes) {
    const probeIds = extractRightmovePropertyIds(probe.property_url);
    const propertyId = [...rightmoveIds].find((value) => probeIds.has(value));
    if (propertyId) {
      propertyMatches.push({ probe, strength: 100, method: 'rightmove_property_id_exact', reason: `Rightmove property ${propertyId}` });
      continue;
    }
    const address = probeAddressEvidence(probe, normalizedContent, content);
    if (address) propertyMatches.push({ probe, ...address });
  }
  const bestStrength = propertyMatches.length ? Math.max(...propertyMatches.map((match) => match.strength)) : 0;
  let bestProbeMatches = propertyMatches.filter((match) => match.strength === bestStrength);
  for (const match of bestProbeMatches) {
    evidence.push({ type: 'property', method: match.method, probe_id: match.probe.probe_id, agency_id: match.probe.agency_id, detail: match.reason });
  }

  const signalSets = agencySignals.map((signal) => signal.matches);
  const agencyCandidates = setIntersection(signalSets);
  if (signalSets.length && agencyCandidates.size === 0) return unmatched(evidence, 'ambiguous', 'conflict');

  if (bestProbeMatches.length && agencyCandidates.size) {
    const reconciled = bestProbeMatches.filter((match) => agencyCandidates.has(match.probe.agency_id));
    if (!reconciled.length) return unmatched(evidence, 'ambiguous', 'conflict');
    bestProbeMatches = reconciled;
  }

  if (bestProbeMatches.length === 1) {
    const selected = bestProbeMatches[0];
    const method = agencySignals.length ? 'multi_signal_exact' : selected.method;
    return {
      match_status: 'matched', matching_method: method,
      agency_id: selected.probe.agency_id, probe_id: selected.probe.probe_id,
      match_score: 1, probe_timestamp: selected.probe.probe_timestamp, evidence,
    };
  }
  if (bestProbeMatches.length > 1) return unmatched(evidence, 'ambiguous', 'unmatched', agencyCandidates.size === 1 ? [...agencyCandidates][0] : '');

  if (agencyCandidates.size > 1) return unmatched(evidence, 'ambiguous');
  if (agencyCandidates.size === 1) {
    const agencyId = [...agencyCandidates][0];
    const method = agencySignals.length === 1 ? agencySignals[0].method : 'multi_signal_exact';
    const agencyProbes = activeProbes.filter((probe) => text(probe.agency_id) === agencyId);
    if (agencyProbes.length === 1 && explicitProbeContext(input, false)) {
      return {
        match_status: 'matched', matching_method: method, agency_id: agencyId,
        probe_id: agencyProbes[0].probe_id, match_score: 1,
        probe_timestamp: agencyProbes[0].probe_timestamp,
        evidence: [...evidence, { type: 'fallback', method: 'agency_then_unique_active_probe', probe_id: agencyProbes[0].probe_id }],
      };
    }
    return unmatched(evidence, agencyProbes.length > 1 && explicitProbeContext(input, false) ? 'ambiguous' : 'unmatched', method, agencyId);
  }

  return unmatched(evidence);
}
