// worker/src/control-server.mjs — the loopback control API.
//
// The Autonomous Probing panel in the existing NOVUS Prober talks to this
// server directly from the browser. Deliberately NOT a Vercel function:
//
//   * the project is on Vercel Hobby with a 12-function ceiling, and this adds
//     none;
//   * a long-lived browser cannot live in a serverless invocation anyway;
//   * the worker and the human share one machine, which is what makes "take
//     over the browser session and finish the CAPTCHA" possible at all.
//
// SECURITY. Bound to 127.0.0.1 so nothing off this machine can reach it. Every
// mutating call additionally needs the bearer token printed at startup, so a
// random page the browser happens to be on cannot start a probing run. Origin
// is checked against the configured NOVUS origins, and the Private Network
// Access preflight is answered explicitly because the calling page is https
// while this server is plain http on loopback.

import http from 'node:http';

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function createControlServer({ config, state, orchestrator, browser }) {
  const corsFor = (origin) => {
    const allowed = config.allowedOrigins.includes(origin);
    if (!allowed) return null;
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      // Chrome sends this preflight for https → http://127.0.0.1.
      'Access-Control-Allow-Private-Network': 'true',
      Vary: 'Origin',
    };
  };

  const snapshot = () => {
    const { run, current, counters, ai, last_success, history, updated_at } = state.data;
    return {
      worker: {
        status: run.mode,
        live_submit: run.live_submit,
        browser_open: Boolean(browser.context),
        pid: process.pid,
        since: run.started_at,
        stop_reason: run.stop_reason,
        cooldown_until: run.cooldown_until || '',
      },
      current: {
        agency_id: current.agency_id,
        agency_name: current.agency_name,
        stage: current.stage,
        branch_url: current.branch_url,
        property_url: current.property_url,
        submission: current.submission.state,
        probe_id: current.probe_id,
        probe_reference: current.probe_reference,
        marked_sent: current.marked_sent,
        last_error: current.last_error,
        last_progress_at: current.last_progress_at,
      },
      // Never phrased as "sent" unless NOVUS confirmed the transition.
      intervention: current.needs_human
        ? { ...current.needs_human, agency_name: current.agency_name, agency_id: current.agency_id, submission: current.submission.state }
        : null,
      counters: {
        completed: counters.completed,
        skipped: counters.skipped,
        failed: counters.failed,
        interventions: counters.interventions,
        completed_today: state.completedToday(),
        batch_size: run.batch_size,
        daily_limit: run.daily_limit,
      },
      ai,
      last_success,
      history: history.slice(0, 10),
      updated_at,
    };
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const cors = corsFor(origin);
    if (origin && !cors) return json(res, 403, { error: 'origin not allowed' });
    const headers = cors || {};

    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, snapshot(), headers);
    }

    if (req.method !== 'POST') return json(res, 404, { error: 'not found' }, headers);

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!config.controlToken || token !== config.controlToken) {
      return json(res, 401, { error: 'operator token missing or wrong' }, headers);
    }

    let body = {};
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json(res, 400, { error: 'invalid JSON body' }, headers); }

    try {
      switch (url.pathname) {
        case '/start': {
          const result = await orchestrator.start({
            batchSize: body.batch_size,
            dailyLimit: body.daily_limit,
            liveSubmit: body.live_submit,
          });
          return json(res, result.ok ? 200 : 409, { ...result, ...snapshot() }, headers);
        }
        case '/pause': return json(res, 200, { ...orchestrator.pause(), ...snapshot() }, headers);
        case '/resume': return json(res, 200, { ...orchestrator.resume(), ...snapshot() }, headers);
        case '/stop-after-agency': return json(res, 200, { ...orchestrator.stopAfterAgency(), ...snapshot() }, headers);
        case '/emergency-stop': return json(res, 200, { ...(await orchestrator.emergencyStop()), ...snapshot() }, headers);
        case '/release': return json(res, 200, { ...orchestrator.release({ outcome: body.outcome }), ...snapshot() }, headers);
        default: return json(res, 404, { error: 'not found' }, headers);
      }
    } catch (error) {
      return json(res, 500, { error: error.message }, headers);
    }
  });

  return { server, snapshot };
}
