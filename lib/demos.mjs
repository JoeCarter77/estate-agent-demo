// lib/demos.mjs — the DEMOS tab: one row = one published personalised demo.
//
// WHY THIS TAB EXISTS. The prospect-facing demo at /demo/{demo_slug} must not
// query PROBES + AGENCIES + INTELLIGENCE + DIAGNOSIS_FINDINGS + PERSONALISATION
// from the browser on every open. DEMOS is the render-ready projection of all
// five: the page resolves one slug, reads one row, and renders it. Nothing
// upstream is read at view time, and nothing upstream is written by this file
// — DEMOS is downstream of the whole pipeline and never feeds back into it.
//
// The row is built ONCE (POST /api/demo {action:'build'}), and the demo shows
// the state of the probe at build time. Rebuilding is an explicit action, not
// something a page view can trigger.
//
// THE SHELL IS ONE DEMO, NOT FOUR. hero_journey selects which content is
// written into this row; the renderer (demo.html) knows nothing about journeys
// and simply renders whatever the row carries. Adding a journey is therefore
// authoring content in lib/demo-journeys.mjs — never a second demo page.
//
// Layout convention, same as every other tab in this workbook:
//   row 1 = header, row 2 = "SCHEMA NOTE ...", row 3+ = data.

import { newDemoId } from './ids.mjs';
import { hasVendorDeclaration } from './vendor-intent.mjs';
import { cleanAddressForEmail, formatEnquiryDate } from './probe-personalisation.mjs';
import { buildJourneyContent, journeySupport, SUPPORTED_HERO_JOURNEYS } from './demo-journeys.mjs';

export const DEMOS_TAB = 'DEMOS';

// Bumped when the SHAPE of the render-ready payload changes in a way the
// renderer cares about, so a stale row is identifiable rather than silently
// half-rendered.
export const DEMO_VERSION = 1;

export const DEMO_STATUSES = ['draft', 'published', 'archived'];

// The canonical column order. `repo.appendRecord` maps object keys onto the
// LIVE header, so a workbook whose DEMOS tab is missing a column simply does
// not persist it — this list is what the tab should be created with.
export const DEMOS_HEADER = [
  // identity
  'demo_id', 'demo_slug', 'demo_status', 'demo_version',
  // links back to the pipeline
  'agency_id', 'probe_id', 'personalisation_id', 'hero_journey',
  // beat 1 — the real event
  'agency_name',
  'property_address', 'property_price', 'property_url', 'property_image_url',
  'enquiry_at', 'enquiry_date', 'enquiry_time',
  // beat 2 — the observed facts
  'seller_declared', 'response_time', 'response_hours', 'contact_attempts',
  'follow_ups', 'channels_used', 'viewing_progression', 'seller_recognition',
  // the copy the prospect reads
  'demo_hook', 'positive_observation', 'demo_reveal', 'main_finding',
  'commercial_consequence', 'systemic_bridge', 'cta_headline',
  // beat 2/3 collections (JSON, deliberately short)
  'observed_events_json', 'novus_detected_json', 'novus_decisions_json', 'novus_actions_json',
  // plumbing
  'created_at', 'updated_at', 'published_at',
  // telemetry
  'first_viewed_at', 'last_viewed_at', 'view_count', 'cta_clicked_at', 'meeting_booked_at',
];

// Columns the browser must never receive. Everything else on the row is
// prospect-safe by construction (it is the copy they read), but the pipeline
// keys are ours.
const INTERNAL_COLUMNS = new Set(['agency_id', 'probe_id', 'personalisation_id', 'demo_id']);

export { SUPPORTED_HERO_JOURNEYS };

// ── small helpers ────────────────────────────────────────────────────────────

function text(value) { return String(value ?? '').trim(); }

// PERSONALISATION's email fields are CONTINUATIONS of a locked prefix
// ("I want to say upfront that " + fair_observation). The demo prints them as
// standalone sentences, so the first letter is raised — the sentence itself is
// never rewritten.
export function sentenceCase(value) {
  const v = text(value);
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// 0.38 -> "23 minutes" · 1.2 -> "1 hour 12 minutes" · 17.85 -> "17.9 hours"
// · 50 -> "2 days". Blank for anything unparseable, which is the honest
// answer when INTELLIGENCE never established a response time.
export function formatResponseTime(hours) {
  const h = parseFloat(hours);
  if (!Number.isFinite(h) || h < 0) return '';
  const minutes = Math.round(h * 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (h < 24) {
    const whole = Math.floor(h);
    const rem = Math.round((h - whole) * 60);
    if (rem === 0) return `${whole} hour${whole === 1 ? '' : 's'}`;
    if (whole < 3) return `${whole} hour${whole === 1 ? '' : 's'} ${rem} minute${rem === 1 ? '' : 's'}`;
    return `${h.toFixed(1)} hours`;
  }
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// '2026-08-11T21:21:04Z' -> '21:21'. Europe/London, for the same reason
// formatEnquiryDate() uses it: an evening probe must show the clock time the
// agency would recognise, not the UTC one.
export function formatEnquiryTime(probeTimestamp) {
  const d = new Date(probeTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London',
  }).format(d);
}

// "voice,email" -> "phone and email". Display only; channels_used is stored raw.
export function formatChannels(channelsUsed) {
  const names = { voice: 'phone', email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };
  const list = text(channelsUsed).split(',').map((c) => names[c.trim().toLowerCase()] || c.trim()).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// ── slug ─────────────────────────────────────────────────────────────────────

export function slugify(value) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// A readable, stable, guessable-but-not-enumerable-enough slug:
//   "Ensum Brown" + "RM-0031" -> "ensum-brown-rm-0031"
// Deterministic, so rebuilding the same probe's demo keeps the same URL. A
// collision with a DIFFERENT probe gets a numeric suffix rather than silently
// stealing the existing demo's URL.
export function buildDemoSlug({ agencyName, probeReference, probeId }, takenBy = new Map()) {
  const base = [slugify(agencyName), slugify(probeReference)].filter(Boolean).join('-')
    || slugify(probeId)
    || 'demo';
  const owner = takenBy.get(base);
  if (!owner || owner === probeId) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    const candidateOwner = takenBy.get(candidate);
    if (!candidateOwner || candidateOwner === probeId) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ── the observed-event list (beat 2) ─────────────────────────────────────────
//
// SHORT ON PURPOSE. The brief is "the minimum real evidence needed to make the
// finding convincing" — not a communications dump. Every entry is a fact this
// probe's own INTELLIGENCE row establishes; nothing here is authored prose and
// nothing is invented when the underlying field is blank.
//
// tone: 'neutral' (it happened) · 'good' (they did this well) · 'gap' (the
// thing that did not happen). The renderer colours on tone alone.

const VIEWING_PROGRESSION_LABELS = {
  none: 'Viewing never progressed',
  mentioned: 'Viewing mentioned',
  invited: 'Buyer invited to view',
  availability_requested: 'Viewing availability requested',
  slot_offered: 'Viewing slot offered',
  booked: 'Viewing booked',
};

const SELLER_RECOGNITION_LABELS = {
  none: 'Seller position never raised',
  asked_position: 'Seller position asked about, never taken further',
  acknowledged: 'Seller acknowledged, no valuation offered',
  valuation_offered: 'Valuation offered',
  valuation_booked: 'Valuation booked',
};

// Everything below valuation_offered leaves the instruction unconverted.
const SELLER_RECOGNITION_CONVERTED = new Set(['valuation_offered', 'valuation_booked']);

export function buildObservedEvents({ intelligence, sellerDeclared, enquiryDate, enquiryTime, responseTime }) {
  const events = [];

  const when = [enquiryDate, enquiryTime].filter(Boolean).join(', ');
  events.push({ label: 'Enquiry submitted', detail: when, tone: 'neutral' });

  if (sellerDeclared) {
    events.push({
      label: 'Property to sell declared',
      detail: 'Stated inside the enquiry itself',
      tone: 'neutral',
    });
  }

  if (responseTime) {
    events.push({ label: 'Your team responded', detail: `${responseTime} later`, tone: 'good' });
  }

  const attempts = parseInt(intelligence.contact_attempts, 10);
  if (Number.isFinite(attempts) && attempts > 0) {
    const channels = formatChannels(intelligence.channels_used);
    events.push({
      label: `${attempts} contact attempt${attempts === 1 ? '' : 's'}`,
      detail: channels ? `Across ${channels}` : '',
      tone: attempts > 1 ? 'good' : 'neutral',
    });
  }

  const progression = text(intelligence.viewing_progression);
  if (progression) {
    events.push({
      label: VIEWING_PROGRESSION_LABELS[progression] || progression,
      detail: '',
      tone: progression === 'none' ? 'gap' : 'good',
    });
  }

  // Only meaningful where the enquiry actually declared a property to sell —
  // seller_recognition is blank otherwise, by design (schema §3 field 14).
  const recognition = text(intelligence.seller_recognition);
  if (sellerDeclared && recognition) {
    events.push({
      label: SELLER_RECOGNITION_LABELS[recognition] || recognition,
      detail: '',
      tone: SELLER_RECOGNITION_CONVERTED.has(recognition) ? 'good' : 'gap',
    });
  }

  return events;
}

// ── the row ──────────────────────────────────────────────────────────────────

// Pure. Every input is a plain row object already read from its tab; nothing
// here touches Sheets, the network or the clock beyond `now`.
//
// Returns { row, warnings }. It never throws on thin upstream data — a blank
// field is rendered as absent, which is the honest outcome. It DOES refuse a
// hero_journey the shell has no content for: see journeySupport().
export function buildDemoRow({
  probe, agency, intelligence, findings, personalisation,
  propertyImageUrl = '', demoId = '', demoSlug = '', existing = null,
  status = 'draft', now = new Date().toISOString(),
}) {
  const warnings = [];
  const heroJourney = text(personalisation?.hero_journey);
  const support = journeySupport(heroJourney);
  if (!support.supported) {
    const err = new Error(support.reason);
    err.code = 'unsupported_hero_journey';
    err.hero_journey = heroJourney;
    throw err;
  }
  if (support.warning) warnings.push(support.warning);

  const agencyName = text(agency?.agency_name);
  const propertyAddress = cleanAddressForEmail(probe?.property_address);
  const enquiryAt = text(probe?.probe_timestamp);
  const sellerDeclared = hasVendorDeclaration(probe);
  const responseTime = formatResponseTime(intelligence?.response_hours);

  if (!agencyName) warnings.push('agency_name is blank — the demo cannot address the agency by name');
  if (!propertyAddress) warnings.push('property_address is blank — beat 1 has no property to show');
  if (!propertyImageUrl) warnings.push('property_image_url is blank — the renderer falls back to the drawn placeholder');

  const enquiryDate = formatEnquiryDate(enquiryAt);
  const enquiryTime = formatEnquiryTime(enquiryAt);

  const context = {
    agencyName,
    propertyAddress,
    propertyPrice: text(probe?.property_price),
    enquiryDate,
    enquiryTime,
    responseTime,
    sellerDeclared,
    intelligence: intelligence || {},
    findings: findings || [],
    personalisation: personalisation || {},
  };

  const journey = buildJourneyContent(heroJourney, context);

  const observedEvents = buildObservedEvents({
    intelligence: intelligence || {},
    sellerDeclared,
    enquiryDate,
    enquiryTime,
    responseTime,
  });

  const row = {
    demo_id: demoId || existing?.demo_id || newDemoId(),
    demo_slug: demoSlug || existing?.demo_slug || '',
    demo_status: DEMO_STATUSES.includes(status) ? status : 'draft',
    demo_version: String(DEMO_VERSION),

    agency_id: text(probe?.agency_id),
    probe_id: text(probe?.probe_id),
    personalisation_id: text(personalisation?.personalisation_id),
    hero_journey: heroJourney,

    agency_name: agencyName,
    property_address: propertyAddress,
    property_price: text(probe?.property_price),
    property_url: text(probe?.property_url),
    property_image_url: text(propertyImageUrl),

    enquiry_at: enquiryAt,
    enquiry_date: enquiryDate,
    enquiry_time: enquiryTime,

    seller_declared: sellerDeclared ? 'yes' : 'no',
    response_time: responseTime,
    response_hours: text(intelligence?.response_hours),
    contact_attempts: text(intelligence?.contact_attempts),
    follow_ups: text(intelligence?.follow_ups),
    channels_used: text(intelligence?.channels_used),
    viewing_progression: text(intelligence?.viewing_progression),
    seller_recognition: text(intelligence?.seller_recognition),

    demo_hook: journey.hook,
    positive_observation: sentenceCase(personalisation?.fair_observation),
    demo_reveal: journey.reveal,
    main_finding: sentenceCase(personalisation?.main_finding),
    commercial_consequence: sentenceCase(personalisation?.commercial_consequence),
    systemic_bridge: journey.systemicBridge,
    cta_headline: journey.ctaHeadline,

    observed_events_json: JSON.stringify(observedEvents),
    novus_detected_json: JSON.stringify(journey.detected),
    novus_decisions_json: JSON.stringify(journey.decisions),
    novus_actions_json: JSON.stringify(journey.actions),

    created_at: existing?.created_at || now,
    updated_at: now,
    published_at: existing?.published_at || (status === 'published' ? now : ''),

    // Telemetry belongs to the row, not to the build — a rebuild must never
    // reset a demo's view history.
    first_viewed_at: existing?.first_viewed_at || '',
    last_viewed_at: existing?.last_viewed_at || '',
    view_count: existing?.view_count || '',
    cta_clicked_at: existing?.cta_clicked_at || '',
    meeting_booked_at: existing?.meeting_booked_at || '',
  };

  if (!row.positive_observation) {
    warnings.push('PERSONALISATION.fair_observation is blank — beat 1 has no "you did this well" line');
  }
  if (!row.commercial_consequence) {
    warnings.push('PERSONALISATION.commercial_consequence is blank — beat 2 has no consequence line');
  }

  return { row, warnings };
}

// ── render-ready projection ──────────────────────────────────────────────────

function parseCollection(value) {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // a hand-mangled cell renders as an absent section, never a broken page
  }
}

// The exact object /api/demo hands the browser. Internal keys are dropped here,
// once, so no route has to remember to strip them.
export function toRenderReady(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (INTERNAL_COLUMNS.has(key)) continue;
    if (key.endsWith('_json')) continue;
    out[key] = value;
  }
  out.observed_events = parseCollection(row?.observed_events_json);
  out.novus_detected = parseCollection(row?.novus_detected_json);
  out.novus_decisions = parseCollection(row?.novus_decisions_json);
  out.novus_actions = parseCollection(row?.novus_actions_json);
  return out;
}

// ── repo access ──────────────────────────────────────────────────────────────

// A workbook with no DEMOS tab reads back as an empty table rather than
// throwing, so a deploy that lands before the tab is created serves a clean
// 404 instead of a 500.
export async function loadDemosTable(repo) {
  try {
    const table = await repo.getTable(DEMOS_TAB);
    return { header: table.header || [], rows: table.rows || [] };
  } catch {
    return { header: [], rows: [] };
  }
}

export function demosTabExists(table) {
  return Array.isArray(table.header) && table.header.includes('demo_slug');
}

// -> [{ rowNumber, obj }] for every real data row, SCHEMA NOTE skipped.
export function demoRecords(table) {
  const slugIdx = table.header.indexOf('demo_slug');
  if (slugIdx === -1) return [];
  const out = [];
  table.rows.forEach((row, i) => {
    const slug = String(row[slugIdx] ?? '').trim();
    if (!slug || slug === 'SCHEMA NOTE') return;
    const obj = {};
    table.header.forEach((key, colIdx) => { obj[key] = row[colIdx] ?? ''; });
    obj.demo_slug = slug;
    out.push({ rowNumber: i + 2, obj });
  });
  return out;
}

export function findDemoBySlug(table, slug) {
  const wanted = text(slug).toLowerCase();
  if (!wanted) return null;
  return demoRecords(table).find((r) => r.obj.demo_slug.toLowerCase() === wanted) || null;
}

export function findDemoByProbe(table, probeId) {
  const wanted = text(probeId);
  if (!wanted) return null;
  return demoRecords(table).find((r) => String(r.obj.probe_id || '').trim() === wanted) || null;
}

// slug -> probe_id, so buildDemoSlug() can tell "this probe's existing slug"
// from "another probe already owns this slug".
export function slugOwners(table) {
  const owners = new Map();
  for (const { obj } of demoRecords(table)) {
    owners.set(obj.demo_slug.toLowerCase(), String(obj.probe_id || '').trim());
  }
  return owners;
}

// Writes ONE fully-formed row with NO read beforehand — the caller already has
// the table snapshot and merges the patch in memory. Used for both the build
// upsert and the telemetry patch, so a page view costs one read and one write.
export async function writeDemoRow(repo, header, rowNumber, obj) {
  const row = header.map((key) => (obj[key] ?? ''));
  await repo.writeRowsBatch([{ tab: DEMOS_TAB, rowNumber, row }]);
}

export const _internal = { INTERNAL_COLUMNS, VIEWING_PROGRESSION_LABELS, SELLER_RECOGNITION_LABELS };
