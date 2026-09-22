// worker/test/mock/server.mjs — an isolated NOVUS backend and a mock Rightmove.
//
// The NOVUS half serves the REAL novus/probe.html from the repository and
// implements /api/novus/probe with the same contract as api/novus/probe.js
// (queue, next, next_after, agency_id, probe_id; create, mark-sent,
// skip-agency). Serving the real page is the point: the tests exercise the
// actual selectors and the actual client-side workflow, so a change to the
// Prober UI breaks them rather than silently breaking the operator.
//
// The Rightmove half reproduces the DOM structure read off live Rightmove:
// the same data-test hooks, the same CSS-module class prefixes, the same
// enquiry field ids and the same sellingSituationType options. No test ever
// reaches the real Rightmove, and no test can send a real enquiry.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

let seq = 0;
const nextId = (prefix) => `${prefix}_test_${String(++seq).padStart(4, '0')}`;

export function createMockWorld(fixture = {}) {
  return {
    agencies: structuredClone(fixture.agencies || []),
    probes: [],
    branches: structuredClone(fixture.branches || {}),     // branchId -> { name, forSale, toRent, listings }
    properties: structuredClone(fixture.properties || {}), // propertyId -> { ... }
    // Test levers.
    submitBehaviour: fixture.submitBehaviour || 'success',  // success | failure | uncertain | captcha
    prefillEnquiry: fixture.prefillEnquiry || null,
    blockPopups: Boolean(fixture.blockPopups),
    log: [],
  };
}

// ── NOVUS API, mirroring api/novus/probe.js ────────────────────────────────

function eligible(agency) {
  return !String(agency.probe_sent || '').trim()
    && /^https?:\/\//i.test(String(agency.rightmove_sales_branch_url || ''))
    && String(agency.email_verification_status || '').toUpperCase() === 'VALID';
}

function queueStats(world) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    remaining: world.agencies.filter(eligible).length,
    completed_today: world.probes.filter((p) => String(p.probe_timestamp || '').startsWith(today)).length,
  };
}

function handleNovusApi(world, req, res, url, body) {
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  if (req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('queue') === '1') return send(200, { queue: queueStats(world) });
    if (q.get('next') === '1' || q.get('next_after')) {
      const after = q.get('next_after');
      const from = after ? world.agencies.findIndex((a) => a.agency_id === after) : -1;
      const found = world.agencies.slice(from + 1).find(eligible);
      if (!found) return send(404, { error: after ? 'No further eligible agency in the list' : 'No eligible agency is ready to probe' });
      return send(200, { agency: found, queue: queueStats(world) });
    }
    if (q.get('agency_id')) {
      const agency = world.agencies.find((a) => a.agency_id === q.get('agency_id'));
      return agency ? send(200, { agency }) : send(404, { error: 'Agency not found' });
    }
    if (q.get('probe_id')) {
      const probe = world.probes.find((p) => p.probe_id === q.get('probe_id'));
      return probe ? send(200, { probe }) : send(404, { error: 'Probe not found' });
    }
    return send(400, { error: 'Missing probe_id, agency_id, next_after, next=1 or queue=1' });
  }

  if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });

  if (body.action === 'create') {
    const agency = world.agencies.find((a) => a.agency_id === body.agency_id);
    if (!body.url) return send(400, { error: 'Missing url' });
    if (!body.agency_id) return send(400, { error: 'Missing agency_id — probe creation is blocked because every NOVUS probe must belong to an agency' });
    if (!agency) return send(400, { error: 'Unknown agency_id' });
    const probe = {
      probe_id: nextId('prb'),
      probe_reference: `RM-${String(world.probes.length + 1).padStart(4, '0')}`,
      agency_id: body.agency_id,
      portal: 'rightmove',
      property_address: world.properties[(/\/properties\/(\d+)/.exec(body.url) || [])[1]]?.address || '',
      property_url: body.url,
      property_price: '',
      probe_email: 'probe@novus.test',
      probe_phone: '+447575333064',
      probe_timestamp: '',
      observation_deadline: '',
      probe_status: 'draft',
      created_at: new Date().toISOString(),
    };
    world.probes.push(probe);
    world.log.push({ op: 'create', probe_id: probe.probe_id, agency_id: body.agency_id, url: body.url });
    return send(200, { probe });
  }

  if (body.action === 'mark-sent') {
    const probe = world.probes.find((p) => p.probe_id === body.probe_id);
    if (!probe) return send(404, { error: 'Probe not found' });
    if (probe.probe_status !== 'draft' && probe.probe_timestamp) return send(200, { probe, already_sent: true });
    const now = new Date();
    probe.probe_status = 'observing';
    probe.probe_timestamp = now.toISOString();
    probe.observation_deadline = new Date(now.getTime() + 4 * 864e5).toISOString();
    const agency = world.agencies.find((a) => a.agency_id === probe.agency_id);
    if (agency) agency.probe_sent = 'YES';
    world.log.push({ op: 'mark-sent', probe_id: probe.probe_id, agency_id: probe.agency_id });
    return send(200, { probe, already_sent: false });
  }

  if (body.action === 'skip-agency') {
    if (body.confirm !== 'DELETE_UNWORKED_AGENCY') return send(400, { error: 'Missing confirm=DELETE_UNWORKED_AGENCY' });
    const index = world.agencies.findIndex((a) => a.agency_id === body.agency_id);
    if (index === -1) return send(404, { error: 'Agency not found' });
    if (world.probes.some((p) => p.agency_id === body.agency_id)) {
      return send(409, { error: 'Agency cannot be hard-deleted because downstream history exists' });
    }
    const [removed] = world.agencies.splice(index, 1);
    const next = world.agencies.slice(index).find(eligible);
    world.log.push({ op: 'skip', agency_id: removed.agency_id, reason: body.reason });
    return send(200, { deleted: true, agency_id: removed.agency_id, reason: body.reason, next_agency_id: next?.agency_id || '', queue: queueStats(world) });
  }

  return send(400, { error: 'Missing or unknown action — expected "create" or "mark-sent"' });
}

// ── mock Rightmove ─────────────────────────────────────────────────────────

const page = (title, body, head = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function branchPage(world, branchId) {
  const branch = world.branches[branchId];
  if (!branch) return null;
  const cards = (branch.listings || []).map((listing) => `
    <div class="propertyCard_propertyCard__ZcGym">
      <a href="https://www.rightmove.co.uk/properties/${listing.id}#/?channel=${listing.channel || 'RES_BUY'}" target="_blank">
        <div class="propertyCard_imageContainer___j8rs"></div>
      </a>
      <div class="propertyCard_cardFooter__hwZOV">
        <div class="propertyCard_priceRow__qJ9R_"><p class="propertyCard_displayPrice__btsUm">${listing.price || ''}</p></div>
        <p class="propertyCard_address__WHew1">${listing.address || ''}</p>
        <div class="propertyCard_propertyInformation__ap5hs">
          <p class="propertyCard_propertyType__jwCRZ">${listing.propertyType || ''}</p>
        </div>
      </div>
    </div>`).join('');
  return page(`${branch.name} | Rightmove`, `
    <h1>${branch.name}</h1>
    <div data-test="propertyList">
      <div class="tabs_tabs__5aj7U propertyList_propertyListControls__rQG_b">
        Properties for sale (${branch.forSale ?? (branch.listings || []).length})
        Properties to rent (${branch.toRent ?? 0})
      </div>
      <div class="propertyList_propertyList__KDn02">${cards}</div>
    </div>`);
}

function propertyPage(world, propertyId) {
  const property = world.properties[propertyId];
  if (!property) return null;
  const canonical = `https://www.rightmove.co.uk/properties/${propertyId}`;
  return page(property.title, `
    <h1>${property.address}</h1>
    <p data-testid="primaryPrice">${property.price || ''}</p>
    <p>${property.description || ''}</p>
    <div data-testid="branchName">${property.branchName}</div>
    <a data-testid="agentLink" href="https://www.rightmove.co.uk/estate-agents/agent/${encodeURIComponent(property.agentSlug)}/Area-${property.branchId}.html">View agent</a>
    <button type="button" onclick="location.href='/property-for-sale/contactBranch.html?backToPropertyURL=%2Fproperties%2F${propertyId}&amp;propertyId=${propertyId}'">Request details</button>
  `, `<link rel="canonical" href="${canonical}">`);
}

function enquiryPage(world, propertyId) {
  const property = world.properties[propertyId];
  if (!property) return null;
  const pre = world.prefillEnquiry || {};
  const behaviour = world.submitBehaviour;
  return page('Property for sale', `
    <h1>Contact ${property.branchName}</h1>
    <form onsubmit="return false">
      <label for="moreDetailsRequested">More details</label><input type="checkbox" id="moreDetailsRequested" name="moreDetailsRequested" checked>
      <label for="toViewProperty">To view a property</label><input type="checkbox" id="toViewProperty" name="toViewProperty">
      <label for="firstName">First name</label><input type="text" id="firstName" name="firstName" value="${pre.firstName || ''}">
      <label for="lastName">Last name</label><input type="text" id="lastName" name="lastName" value="${pre.lastName || ''}">
      <label for="phone.number">Telephone</label><input type="tel" id="phone.number" name="phone.number" value="${pre.phone || ''}">
      <label for="email">Email</label><input type="email" id="email" name="email" value="${pre.email || ''}">
      <label for="postcode">Postcode</label><input type="text" id="postcode" name="postcode" value="${pre.postcode || ''}">
      <label for="comments">Your message (Optional)</label><textarea id="comments" name="comments"></textarea>
      <label for="sellingSituationType">I have a property to sell</label>
      <select id="sellingSituationType" name="sellingSituationType">
        <option value="">Please select</option><option value="no">No</option>
        <option value="pr_not_on_mrk">Yes, it is not yet on the market</option>
        <option value="pr_on_mrk">Yes, it is on the market already</option>
      </select>
      ${world.omitSellingSituation ? '' : ''}
      <label for="valuationRequested">Get a free valuation of my property</label>
      <input type="checkbox" id="valuationRequested" name="valuationRequested" ${pre.valuationRequested ? 'checked' : ''}>
      <button type="button" data-testid="submitButton">Send email</button>
    </form>
    <div id="captcha-host"></div>
    <script>
      const behaviour = ${JSON.stringify(behaviour)};
      document.querySelector('[data-testid="submitButton"]').addEventListener('click', () => {
        window.__submitted = (window.__submitted || 0) + 1;
        // Record exactly what the operator was about to send, so tests can
        // assert on the enquiry itself rather than on the operator's own logs.
        const value = (id) => document.getElementById(id)?.value ?? '';
        navigator.sendBeacon('/mock/enquiry-submitted', JSON.stringify({
          propertyId: new URLSearchParams(location.search).get('propertyId'),
          firstName: value('firstName'), lastName: value('lastName'),
          email: value('email'), phone: document.getElementById('phone.number')?.value ?? '',
          postcode: value('postcode'), comments: value('comments'),
          sellingSituation: value('sellingSituationType'),
          valuationRequested: document.getElementById('valuationRequested')?.checked === true,
          moreDetailsRequested: document.getElementById('moreDetailsRequested')?.checked === true,
        }));
        setTimeout(() => {
          if (behaviour === 'success') {
            document.body.innerHTML = '<h1>Your enquiry has been sent</h1><p>Thanks for your enquiry.</p>';
          } else if (behaviour === 'failure') {
            const el = document.createElement('div');
            el.className = 'form-error'; el.setAttribute('role','alert');
            el.textContent = 'Please enter a valid telephone number';
            document.querySelector('form').prepend(el);
          } else if (behaviour === 'uncertain') {
            document.querySelector('form').remove();
            document.body.insertAdjacentHTML('beforeend', '<p>Loading…</p>');
          } else if (behaviour === 'captcha') {
            document.getElementById('captcha-host').innerHTML =
              '<div style="width:400px;height:400px"><div><iframe src="https://www.google.com/recaptcha/api2/bframe?k=test" style="width:400px;height:400px"></iframe></div></div>';
          }
        }, 150);
      });
    </script>`);
}

// ── the server ─────────────────────────────────────────────────────────────

export function startMockServer(world) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (url.pathname === '/mock/enquiry-submitted') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }
      world.log.push({ op: 'enquiry-submitted', ...payload });
      res.writeHead(204); return res.end();
    }

    // NOVUS API
    if (url.pathname === '/api/novus/probe') {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      }
      return handleNovusApi(world, req, res, url, body);
    }

    // NOVUS pages — the real files from the repository.
    if (url.pathname === '/novus/probe' || url.pathname === '/novus') {
      let html = fs.readFileSync(path.join(REPO, 'novus/probe.html'), 'utf8');
      // The popup-blocked scenario: neuter window.open exactly as a blocker would.
      if (world.blockPopups) html = html.replace('<body>', '<body><script>window.open = () => null;</script>');
      return send(200, html);
    }
    if (url.pathname.startsWith('/novus/')) {
      const file = path.join(REPO, url.pathname);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
      return send(200, '', MIME[path.extname(url.pathname)] || 'text/plain');   // vendored assets we do not need
    }

    // Mock Rightmove
    let match = /\/estate-agents\/agent\/[^/]+\/[^/]*?(\d+)\.html/.exec(url.pathname);
    if (match) {
      const html = branchPage(world, match[1]);
      return html ? send(200, html) : send(404, page('Rightmove', "<h1>This isn't the place you were looking for!</h1>"));
    }
    match = /^\/properties\/(\d+)/.exec(url.pathname);
    if (match) {
      const html = propertyPage(world, match[1]);
      return html ? send(200, html) : send(404, page('Rightmove', "<h1>This isn't the place you were looking for!</h1>"));
    }
    if (url.pathname === '/property-for-sale/contactBranch.html') {
      const html = enquiryPage(world, url.searchParams.get('propertyId'));
      return html ? send(200, html) : send(404, page('Rightmove', '<h1>Not found</h1>'));
    }

    return send(404, page('Not found', '<h1>404</h1>'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, world });
    });
  });
}

// Route every rightmove.co.uk request in the operator's browser to the mock
// server, so URLs keep their real shape (and the operator's own
// rightmove.co.uk tab detection is exercised) while no traffic leaves the box.
export async function routeRightmoveToMock(context, origin) {
  await context.route('**://*.rightmove.co.uk/**', async (route) => {
    const target = new URL(route.request().url());
    const proxied = `${origin}${target.pathname}${target.search}`;
    const request = route.request();
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method()) ? request.postData() : undefined;
    const response = await fetch(proxied, { method: request.method(), body, redirect: 'follow' });
    route.fulfill({
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') || 'text/html; charset=utf-8' },
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
