// lib/call-intelligence.mjs — post-call transcription + low-cost structured sales intelligence.
//
// Deliberately runs only after a call has a usable recording and clears the
// configured duration threshold. The transcript is persisted once; subsequent
// product analytics should read the stored structured result rather than paying
// a model to rediscover the same facts.
//
// OpenAI is used here independently of NOVUS's existing Anthropic probe stack:
// gpt-transcribe handles audio and gpt-4o-mini handles the small extraction job.

import { fetchTwilioRecording } from './twilio-recording.mjs';

function text(value) { return String(value ?? '').trim(); }
function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

export function minimumCallSeconds(env = process.env) {
  const configured = Number(env.NOVUS_CALL_AI_MIN_SECONDS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 45;
}

export function shouldAnalyseCall(durationSeconds, env = process.env) {
  const duration = Number(durationSeconds);
  return Number.isFinite(duration) && duration >= minimumCallSeconds(env);
}

async function openAiJson(url, { apiKey, init, fetchImpl }) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI API error ${response.status}`);
  return data;
}

export async function transcribeSalesCall({
  recordingReference,
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  const apiKey = text(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const recording = await fetchTwilioRecording(recordingReference, { fetchImpl });
  const form = new FormData();
  form.set('model', text(env.NOVUS_CALL_TRANSCRIBE_MODEL) || 'gpt-transcribe');
  form.set('file', new Blob([recording.bytes], { type: recording.contentType || 'audio/mpeg' }), 'novus-call.mp3');

  const data = await openAiJson('https://api.openai.com/v1/audio/transcriptions', {
    apiKey,
    fetchImpl,
    init: { method: 'POST', body: form },
  });
  const transcript = text(data.text);
  if (!transcript) throw new Error('Transcription returned no text');
  return transcript;
}

const ANALYSIS_KEYS = [
  'decision_maker_reached','call_outcome','meeting_booked','meeting_date',
  'agency_priority','main_constraint','current_process','pain_points','objections',
  'crm_used','branches','interest_level','seller_opportunity_problem','database_problem',
  'lead_generation_problem','summary','useful_phrases','next_action','confidence',
];

function normaliseAnalysis(raw) {
  const out = {};
  for (const key of ANALYSIS_KEYS) out[key] = raw?.[key] ?? null;
  out.decision_maker_reached = typeof out.decision_maker_reached === 'boolean' ? out.decision_maker_reached : null;
  out.meeting_booked = Boolean(out.meeting_booked);
  out.meeting_date = text(out.meeting_date) || null;
  out.agency_priority = text(out.agency_priority) || null;
  out.main_constraint = text(out.main_constraint) || null;
  out.current_process = text(out.current_process) || null;
  out.crm_used = text(out.crm_used) || null;
  out.branches = Number.isInteger(Number(out.branches)) && Number(out.branches) > 0 ? Number(out.branches) : null;
  out.interest_level = ['LOW','MEDIUM','HIGH'].includes(text(out.interest_level).toUpperCase())
    ? text(out.interest_level).toUpperCase() : null;
  for (const key of ['seller_opportunity_problem','database_problem','lead_generation_problem']) {
    out[key] = typeof out[key] === 'boolean' ? out[key] : null;
  }
  out.pain_points = Array.isArray(out.pain_points) ? out.pain_points.map(text).filter(Boolean).slice(0, 8) : [];
  out.objections = Array.isArray(out.objections) ? out.objections.map(text).filter(Boolean).slice(0, 8) : [];
  out.useful_phrases = Array.isArray(out.useful_phrases) ? out.useful_phrases.map(text).filter(Boolean).slice(0, 8) : [];
  out.summary = text(out.summary).slice(0, 1800);
  out.next_action = text(out.next_action) || null;
  out.call_outcome = [
    'NO_ANSWER','GATEKEEPER','OWNER_CONVERSATION','MEETING_BOOKED',
    'NOT_INTERESTED','CALL_LATER','OTHER',
  ].includes(text(out.call_outcome).toUpperCase()) ? text(out.call_outcome).toUpperCase() : 'OTHER';
  out.confidence = clamp01(out.confidence);
  return out;
}

export async function analyseSalesTranscript({
  transcript,
  agencyName = '',
  contactName = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  const apiKey = text(env.OPENAI_API_KEY);
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const model = text(env.NOVUS_CALL_ANALYSIS_MODEL) || 'gpt-4o-mini';

  const schemaInstruction = {
    decision_maker_reached: 'boolean|null',
    call_outcome: 'NO_ANSWER|GATEKEEPER|OWNER_CONVERSATION|MEETING_BOOKED|NOT_INTERESTED|CALL_LATER|OTHER',
    meeting_booked: 'boolean',
    meeting_date: 'string|null',
    agency_priority: 'string|null',
    main_constraint: 'string|null',
    current_process: 'string|null',
    pain_points: ['string'],
    objections: ['string'],
    crm_used: 'string|null',
    branches: 'integer|null',
    interest_level: 'LOW|MEDIUM|HIGH|null',
    seller_opportunity_problem: 'boolean|null',
    database_problem: 'boolean|null',
    lead_generation_problem: 'boolean|null',
    summary: 'string',
    useful_phrases: ['short exact prospect phrase'],
    next_action: 'string|null',
    confidence: 'number 0..1',
  };

  const prompt = [
    'Analyse this NOVUS cold-sales call with an independent UK estate agency.',
    'Extract only facts supported by the transcript. Never infer a CRM, branch count, priority, problem or meeting that was not actually stated.',
    'The purpose is market research as well as sales logging: preserve the owner/prospect\'s own commercial language where useful.',
    `Agency: ${text(agencyName) || 'unknown'}`,
    `Known contact: ${text(contactName) || 'unknown'}`,
    `Required JSON shape: ${JSON.stringify(schemaInstruction)}`,
    'Transcript:',
    text(transcript),
  ].join('\n\n');

  const data = await openAiJson('https://api.openai.com/v1/chat/completions', {
    apiKey,
    fetchImpl,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a precise sales-call evidence extractor. Return one JSON object only.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
  });

  const rawText = text(data?.choices?.[0]?.message?.content);
  if (!rawText) throw new Error('Call analysis returned no content');
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch { throw new Error('Call analysis returned invalid JSON'); }
  return { analysis: normaliseAnalysis(parsed), model };
}

export async function processSalesCallIntelligence({
  recordingReference,
  durationSeconds,
  agencyName = '',
  contactName = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
}) {
  if (!shouldAnalyseCall(durationSeconds, env)) {
    return {
      skipped: true,
      reason: `duration_below_${minimumCallSeconds(env)}s`,
      transcript: '',
      analysis: null,
      model: '',
    };
  }

  const transcript = await transcribeSalesCall({ recordingReference, fetchImpl, env });
  const analysed = await analyseSalesTranscript({ transcript, agencyName, contactName, fetchImpl, env });
  return {
    skipped: false,
    reason: '',
    transcript,
    analysis: analysed.analysis,
    model: `${text(env.NOVUS_CALL_TRANSCRIBE_MODEL) || 'gpt-transcribe'}+${analysed.model}`,
  };
}

export const _internal = { normaliseAnalysis };
