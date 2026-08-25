// lib/ai-structured-output.mjs — the ONE place a model's structured tool
// result is turned into a trustworthy object.
//
// WHY THIS EXISTS. The Anthropic Messages API returns a tool_use block whose
// `input` is already parsed JSON, so for a long time callers used it raw. Two
// failure modes then reached persisted Personalisation fields:
//
//   1. TOOL MARKUP LEAKED INTO A VALUE. Rows persisted a primary_narrative
//      ending "...ever existed.</primary_narrative>\n<parameter
//      name="supporting_findings">" while the supporting_findings key came
//      back empty. The serving path had emitted the call in its text
//      parameter format and the boundary between two parameters landed
//      INSIDE the first one's string. Everything after that boundary — the
//      remaining parameters — was lost, which is why the same rows are also
//      the rows missing commercial_consequence and email_commercial_hook.
//
//   2. TRUNCATION WAS SILENT. A response that stops at max_tokens still
//      carries a tool_use block, just a partial one. The caller saw a normal
//      object with the tail keys missing and persisted half a record. That is
//      the prb_hist_0005 shape exactly: indexes and the two early prose keys
//      present, every field after them blank.
//
// Neither is fixed by stripping a known string after the fact. Both are the
// same root problem — nothing owned the contract between "what the model
// emitted" and "what the caller may rely on" — so that contract lives here:
// recover the run-together fields back into their real keys, scrub any
// residual markup, then assert the schema's required keys actually arrived.
// A caller that gets an object from here can trust every key in it.

// A parameter boundary in the text tool-call format, in the shapes that have
// actually been observed: <parameter name="x">, <parameter name="x">,
// and the closing form of either.
const PARAM_OPEN_RE = /<\s*(?:antml:)?parameter\s+name\s*=\s*["']([a-zA-Z0-9_]+)["']\s*>/i;
const PARAM_CLOSE_RE = /<\s*\/\s*(?:antml:)?parameter\s*>/i;

// Any leftover markup: a parameter tag, an invoke/function_calls wrapper, or a
// bare <field>/</field> tag naming a schema property.
function residualMarkupRe(keys) {
  const names = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    String.raw`<\s*\/?\s*(?:antml:)?(?:parameter\b[^>]*|invoke\b[^>]*|function_calls|function_results|${names})\s*\/?>`,
    'gi',
  );
}

// True when a persisted-looking string still carries tool/schema markup. The
// regression guard: no value returned from here may satisfy this.
export function containsToolMarkup(value, keys = []) {
  const text = String(value ?? '');
  if (!text) return false;
  if (PARAM_OPEN_RE.test(text) || PARAM_CLOSE_RE.test(text)) return true;
  return residualMarkupRe(keys.length ? keys : ['x']).test(text);
}

// Split one leaked string back into { head, recovered }.
//
// head        — the part that genuinely belonged to the key being read.
// recovered   — Map(key -> value) for the parameters that were swallowed into
//               the same string, in the order they appeared.
//
// The first boundary encountered ends the head, whether that boundary is the
// key's own closing tag, a closing </parameter>, or the next parameter's
// opening tag. Everything after is walked as a sequence of
// <parameter name="k">value pairs.
export function splitLeakedValue(key, value, schemaKeys) {
  const text = String(value ?? '');
  const own = new RegExp(String.raw`<\s*\/\s*(?:antml:)?${key.replace(/[^a-zA-Z0-9_]/g, '')}\s*>`, 'i');
  const boundaries = [own, PARAM_CLOSE_RE, PARAM_OPEN_RE]
    .map((re) => text.search(re)).filter((i) => i >= 0);
  if (boundaries.length === 0) return { head: text, recovered: new Map() };

  const cut = Math.min(...boundaries);
  const head = text.slice(0, cut);
  const recovered = new Map();

  let rest = text.slice(cut);
  const allowed = new Set(schemaKeys);
  // Walk every remaining <parameter name="k"> segment. A segment's value runs
  // to the next parameter boundary, mirroring how the emitter wrote it.
  for (;;) {
    const open = rest.match(new RegExp(PARAM_OPEN_RE.source, 'i'));
    if (!open) break;
    const name = open[1];
    const after = rest.slice(open.index + open[0].length);
    const nextBoundaries = [PARAM_OPEN_RE, PARAM_CLOSE_RE, /<\s*\/\s*(?:antml:)?[a-zA-Z0-9_]+\s*>/i]
      .map((re) => after.search(re)).filter((i) => i >= 0);
    const end = nextBoundaries.length ? Math.min(...nextBoundaries) : after.length;
    if (allowed.has(name) && !recovered.has(name)) recovered.set(name, after.slice(0, end).trim());
    rest = after.slice(end === after.length ? end : end + 1);
    if (!rest) break;
  }
  return { head, recovered };
}

// Does this value satisfy its declared schema type? Deliberately shallow — the
// question here is only "did this key actually arrive", not full JSON-schema
// validation. Anything not declared, or declared as a union including null,
// passes on presence alone.
function satisfiesSchema(value, property) {
  if (value === undefined) return false;
  const declared = property?.type;
  const types = Array.isArray(declared) ? declared : declared ? [declared] : [];
  if (types.length === 0) return true;
  return types.some((type) => (
    type === 'null' ? value === null
      : type === 'string' ? typeof value === 'string'
        : type === 'integer' ? Number.isInteger(value)
          : type === 'number' ? typeof value === 'number'
            : type === 'boolean' ? typeof value === 'boolean'
              : type === 'array' ? Array.isArray(value)
                : type === 'object' ? value !== null && typeof value === 'object'
                  : true));
}

export class AiStructuredOutputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AiStructuredOutputError';
    Object.assign(this, details);
  }
}

// tool: the JSON-schema tool that was forced. input: the tool_use block's
// parsed input. Returns a repaired object; throws AiStructuredOutputError when
// the result cannot be trusted (a required key is still missing after
// recovery), so the caller retries or fails loudly rather than persisting a
// half record.
// requireComplete: assert the schema's required keys actually arrived. TRUE for
// anything off the wire, where a missing tail key is the signature of a
// truncated or mis-parsed response and persisting it would write a half
// record. FALSE for an injected test fake, which is not a wire artefact — a
// fixture supplies the fields its own assertions are about, and forcing every
// one of a dozen fixtures to enumerate every schema key would add noise
// without adding safety. Markup recovery and scrubbing run for BOTH, so a
// fixture can still prove the leak fix end to end.
export function normaliseToolInput(input, tool, { truncated = false, requireComplete = true } = {}) {
  const schema = tool?.input_schema || {};
  const schemaKeys = Object.keys(schema.properties || {});
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!input || typeof input !== 'object') {
    throw new AiStructuredOutputError('Tool result was not an object', { truncated });
  }

  const out = { ...input };
  const markupRe = residualMarkupRe(schemaKeys);

  // Pass 1 — recover leaked parameters out of whichever value swallowed them.
  for (const key of schemaKeys) {
    const value = out[key];
    if (typeof value !== 'string' || !containsToolMarkup(value, schemaKeys)) continue;
    const { head, recovered } = splitLeakedValue(key, value, schemaKeys);
    out[key] = head;
    for (const [name, recoveredValue] of recovered) {
      const existing = out[name];
      // Only fill a key the leak actually stole — never overwrite a value the
      // parser already received cleanly.
      if (typeof existing !== 'string' || !existing.trim()) out[name] = recoveredValue;
    }
  }

  // Pass 2 — scrub any residual markup from every string, including keys the
  // recovery walk did not name.
  for (const key of Object.keys(out)) {
    if (typeof out[key] !== 'string') continue;
    out[key] = out[key].replace(markupRe, '').replace(/\s+/g, ' ').trim();
  }

  // Pass 3 — the contract. A truncated response is never trustworthy, and a
  // required key that is still absent means the recovery could not put the
  // record back together.
  const missing = required.filter((key) => !satisfiesSchema(out[key], schema.properties?.[key]));
  if (truncated) {
    throw new AiStructuredOutputError('Model response hit max_tokens before the tool result was complete', {
      truncated: true, missing,
    });
  }
  if (requireComplete && missing.length) {
    throw new AiStructuredOutputError(`Tool result is missing required fields: ${missing.join(', ')}`, {
      truncated: false, missing,
    });
  }
  return out;
}

export const _internal = { PARAM_OPEN_RE, PARAM_CLOSE_RE, residualMarkupRe };
