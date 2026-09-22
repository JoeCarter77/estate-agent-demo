// worker/src/ai.mjs — the ONLY place the operator spends money on a model.
//
// The operator is deliberately not an LLM driving a mouse. Everything with a
// stable selector — navigation, tabs, reading a URL, clicking Create probe,
// clicking Mark as sent — is ordinary Playwright. A model is consulted only
// when the page genuinely has to be interpreted:
//
//   assessListing        the deterministic listing classifier was not
//                        confident (unusual wording, no property-type label).
//   classifyUnknownPage  a page the workflow did not expect: is this a
//                        CAPTCHA, an expired login, an error, or something the
//                        human must look at?
//
// Every call is metered. Token counts come back from the API and are converted
// with the model's published rates, so the panel can show real spend rather
// than a guess.

import { getAnthropicApiKey } from '../../lib/anthropic-server.mjs';

const ANTHROPIC_VERSION = '2023-06-01';

// USD per million tokens. Used only for the operator's own cost display.
const RATES = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-5': { input: 15, output: 75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

function priceOf(model, usage) {
  const rate = RATES[model] || RATES['claude-sonnet-5'];
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  return {
    inputTokens: input,
    outputTokens: output,
    costUsd: (input / 1e6) * rate.input + (output / 1e6) * rate.output,
  };
}

// Injectable for tests: no network, no key, no spend.
let callerOverride = null;
export function __setAiCallerForTests(fn) { callerOverride = fn; }

async function callTool({ system, content, tool, model, maxTokens = 1024 }) {
  if (callerOverride) return callerOverride({ system, content, tool, model });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getAnthropicApiKey(),
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Anthropic API error ${response.status}`);
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!block) throw new Error('Model did not return the requested tool call');
  return { result: block.input, usage: data.usage || null };
}

function imageBlock(screenshotBase64) {
  return screenshotBase64
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } }]
    : [];
}

const SUITABILITY_TOOL = {
  name: 'record_listing_assessment',
  description: 'Record whether a Rightmove listing is an ordinary residential sales property suitable for a NOVUS probe.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['suitable', 'unsuitable', 'uncertain'],
        description: 'suitable = an ordinary residential house or apartment for sale. unsuitable = lettings, land, commercial, auction-only, retirement-scheme-only, or unavailable. uncertain = cannot tell from what is shown.',
      },
      category: {
        type: 'string',
        enum: ['residential_sale', 'lettings', 'land', 'commercial', 'new_build_development', 'unavailable', 'unknown'],
      },
      reason: { type: 'string', description: 'One sentence, naming the evidence on the page.' },
    },
    required: ['verdict', 'category', 'reason'],
  },
};

export async function assessListing({ model, text, screenshotBase64 }) {
  const { result, usage } = await callTool({
    model,
    system: 'You classify Rightmove property listings for an estate-agency research programme. Judge ONLY from what is shown. Prefer "uncertain" over a guess: an uncertain verdict sends the case to a human, which is cheap, whereas a wrong "suitable" sends a real enquiry about the wrong kind of property.',
    content: [
      ...imageBlock(screenshotBase64),
      { type: 'text', text: `Listing text:\n\n${String(text || '').slice(0, 6000)}` },
    ],
    tool: SUITABILITY_TOOL,
  });
  return { ...result, usage: priceOf(model, usage) };
}

const PAGE_TOOL = {
  name: 'record_page_situation',
  description: 'Say what an unexpected page in the probing workflow actually is, and whether the human must take over.',
  input_schema: {
    type: 'object',
    properties: {
      situation: {
        type: 'string',
        enum: ['captcha', 'login_required', 'verification_challenge', 'page_unavailable', 'rate_limited', 'normal_page', 'other'],
      },
      requires_human: { type: 'boolean', description: 'True when only the account holder can clear this.' },
      reason: { type: 'string' },
    },
    required: ['situation', 'requires_human', 'reason'],
  },
};

export async function classifyUnknownPage({ model, url, text, screenshotBase64 }) {
  const { result, usage } = await callTool({
    model,
    system: 'You triage unexpected pages hit by an authorised browser automation. Never suggest bypassing a human-verification challenge: your only job is to name what the page is and whether the account holder must handle it personally.',
    content: [
      ...imageBlock(screenshotBase64),
      { type: 'text', text: `URL: ${url}\n\nVisible text:\n\n${String(text || '').slice(0, 4000)}` },
    ],
    tool: PAGE_TOOL,
  });
  return { ...result, usage: priceOf(model, usage) };
}
