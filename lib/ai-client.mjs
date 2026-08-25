// lib/ai-client.mjs — the ONLY place that calls the Anthropic Messages API
// for probe interpretation/diagnosis. Thin and swappable, same shape as
// lib/sheets.mjs: a single call() function, production wired to fetch by
// default, tests inject a fake via __setAiCallerForTests() so nothing here
// needs network or credentials to be exercised.
//
// Always uses tool_choice to force a single structured JSON result — never
// free-text parsing. Callers pass a JSON-schema-shaped tool; call() returns
// that tool's parsed input directly.
//
// THE RESULT IS NORMALISED BEFORE IT IS RETURNED. A tool_use block's `input`
// is parsed JSON but it is not automatically a COMPLETE or CLEAN record: a
// response that stopped at max_tokens still carries one, and a serving path
// that emitted the call in its text parameter format can land the boundary
// between two parameters inside the first one's string. Both used to reach
// persisted sheet fields. lib/ai-structured-output.mjs owns that contract now
// and every caller — including the injected test fake, deliberately — goes
// through it, so a fixture can never assert on a shape production would
// reject. See that file's header for the two failure modes in full.

import { normaliseToolInput } from './ai-structured-output.mjs';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';

// Was 2000. Personalisation's tool has eleven fields, several of them prose,
// and 2000 truncated real records mid-result — which the old client returned
// as a normal object with the tail keys missing. Truncation is now an error
// rather than a half record, and the budget is large enough that it should not
// be reached at all.
const DEFAULT_MAX_TOKENS = 4000;

async function realCall({ system, prompt, tool, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((block) => block.type === 'tool_use' && block.name === tool.name);
  if (!toolUse) throw new Error('Anthropic API did not return the requested tool call');
  return normaliseToolInput(toolUse.input, tool, { truncated: data.stop_reason === 'max_tokens' });
}

let _callerOverride = null;

// Test-only: replace the AI caller with a deterministic fake, e.g.
// __setAiCallerForTests(async ({ tool }) => ({ ...fixedAnswer })).
export function __setAiCallerForTests(fn) { _callerOverride = fn; }

// { system, prompt, tool: { name, description, input_schema }, model?, maxTokens? }
// -> the tool call's parsed, normalised `input` object.
export async function callAi(args) {
  if (_callerOverride) {
    // Fakes go through the same markup recovery and scrubbing as the wire — a
    // fixture that returns leaked markup must see exactly what production
    // sees. The required-key completeness assertion is wire-only: see
    // normaliseToolInput's requireComplete.
    return normaliseToolInput(await _callerOverride(args), args.tool, {
      truncated: false, requireComplete: false,
    });
  }
  return realCall(args);
}

export const _internal = { DEFAULT_MAX_TOKENS, DEFAULT_MODEL };
