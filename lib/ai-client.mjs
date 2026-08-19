// lib/ai-client.mjs — the ONLY place that calls the Anthropic Messages API
// for probe interpretation/diagnosis. Thin and swappable, same shape as
// lib/sheets.mjs: a single call() function, production wired to fetch by
// default, tests inject a fake via __setAiCallerForTests() so nothing here
// needs network or credentials to be exercised.
//
// Always uses tool_choice to force a single structured JSON result — never
// free-text parsing. Callers pass a JSON-schema-shaped tool; call() returns
// that tool's parsed input directly.

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';

async function realCall({ system, prompt, tool, model = DEFAULT_MODEL, maxTokens = 2000 }) {
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
  return toolUse.input;
}

let _callerOverride = null;

// Test-only: replace the AI caller with a deterministic fake, e.g.
// __setAiCallerForTests(async ({ tool }) => ({ ...fixedAnswer })).
export function __setAiCallerForTests(fn) { _callerOverride = fn; }

// { system, prompt, tool: { name, description, input_schema }, model?, maxTokens? }
// -> the tool call's parsed `input` object.
export async function callAi(args) {
  if (_callerOverride) return _callerOverride(args);
  return realCall(args);
}
