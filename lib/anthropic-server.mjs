// Server-only Anthropic environment/key resolution and safe usage telemetry.
// Never import this module from browser code.

let localEnvLoaded = false;

function loadLocalEnvFiles() {
  if (localEnvLoaded || typeof process.loadEnvFile !== 'function') return;
  localEnvLoaded = true;
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function getAnthropicEnvironment(env = process.env) {
  if (env.VERCEL_ENV === 'production') return 'production';
  if (env.VERCEL_ENV === 'preview') return 'preview';
  return 'local';
}

export function anthropicApiKeyVariable(env = process.env) {
  return getAnthropicEnvironment(env) === 'production'
    ? 'NOVUS_PRODUCTION_API'
    : 'NOVUS_DEVELOPMENT_API';
}

export function hasAnthropicApiKey({ env = process.env, loadLocalEnv = env === process.env } = {}) {
  if (loadLocalEnv && getAnthropicEnvironment(env) === 'local') loadLocalEnvFiles();
  if (env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is legacy and must be removed; configure the environment-specific NOVUS Anthropic variable instead.');
  }
  return Boolean(env[anthropicApiKeyVariable(env)]);
}

export function getAnthropicApiKey(options = {}) {
  const env = options.env || process.env;
  if (hasAnthropicApiKey({ env, loadLocalEnv: options.loadLocalEnv ?? env === process.env })) {
    return env[anthropicApiKeyVariable(env)];
  }
  throw new Error(`${anthropicApiKeyVariable(env)} is not configured`);
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : null;
}

export function logAnthropicUsage({
  environment,
  model,
  purpose,
  usage,
  serverToolsEnabled = false,
  webSearchEnabled = false,
  success,
  latencyMs,
}) {
  console.log('[anthropic_usage]', JSON.stringify({
    timestamp: new Date().toISOString(),
    environment,
    model,
    purpose: String(purpose || 'unspecified').slice(0, 80),
    input_tokens: tokenCount(usage?.input_tokens),
    output_tokens: tokenCount(usage?.output_tokens),
    server_tools_enabled: Boolean(serverToolsEnabled),
    web_search_enabled: Boolean(webSearchEnabled),
    success: Boolean(success),
    latency_ms: Math.max(0, Math.round(Number(latencyMs) || 0)),
  }));
}
