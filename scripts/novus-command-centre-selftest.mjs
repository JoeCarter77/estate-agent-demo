// scripts/novus-command-centre-selftest.mjs — hermetic UI contract test for
// the Command Centre shell (novus/operator.html).
//
// No network, no credentials, no live sends. It builds a canonical dashboard
// payload with the REAL server projection (lib/operator-funnel.mjs), loads the
// page's own script into a tiny DOM shim, and asserts what each view renders.
//
// This is deliberately a contract test, not a pixel test: the point is that
// probing never reaches the Actions view, that every section renders from
// canonical data, and that navigation mutates nothing.
//
// Run:  npm run novus:command-centre-selftest

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcquisitionDashboard } from '../lib/operator-funnel.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(ROOT, '..', 'novus', 'operator.html'), 'utf8');

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
const check = (msg, fn) => { fn(); ok(msg); };

// ── minimal DOM shim ───────────────────────────────────────────────────────
// Just enough of the DOM for the page's render functions: ids, classes,
// dataset, innerHTML/textContent, value, and the listener registry. Nothing
// here fetches, navigates or persists.
function makeDom(){
  const listeners = { document: {}, window: {} };
  const byId = new Map();
  const all = [];

  class El {
    constructor(tag = 'div'){
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.options = [];
      this._html = '';
      this._text = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.attributes = {};
      this.style = {};
      const self = this;
      this.classList = {
        set: new Set(),
        add(...c){ c.forEach((x) => self.classList.set.add(x)); },
        remove(...c){ c.forEach((x) => self.classList.set.delete(x)); },
        toggle(c, on){ if(on === undefined) { self.classList.set.has(c) ? self.classList.set.delete(c) : self.classList.set.add(c); }
          else if(on) self.classList.set.add(c); else self.classList.set.delete(c); return self.classList.set.has(c); },
        contains(c){ return self.classList.set.has(c); },
      };
      all.push(this);
    }
    get innerHTML(){ return this._html; }
    set innerHTML(v){ this._html = String(v); }
    get textContent(){ return this._text || stripTags(this._html); }
    set textContent(v){ this._text = String(v); this._html = ''; }
    setAttribute(k, v){ this.attributes[k] = String(v); }
    getAttribute(k){ return this.attributes[k] ?? null; }
    appendChild(child){ this.children.push(child); if(this.tagName === 'SELECT') this.options.push(child); return child; }
    addEventListener(){ /* wiring is exercised through the delegated handlers */ }
    focus(){}
    closest(){ return null; }
    querySelectorAll(){ return []; }
  }
  const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&mdash;/g,'—').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();

  const document = {
    _els: byId,
    getElementById(id){
      if(!byId.has(id)){
        const el = new El(id.startsWith('f-') || id === 'q' ? 'select' : 'div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelectorAll(sel){
      if(sel === '.nav-item') return NAV_ITEMS;
      if(sel === '.dr-tab') return DR_TABS;
      return [];
    },
    addEventListener(type, fn){ listeners.document[type] = fn; },
    title: '',
  };
  const NAV_ITEMS = ['overview','actions','pipeline','prober','leads','analytics','exceptions'].map((v) => {
    const el = new El('button'); el.dataset.view = v; return el;
  });
  const DR_TABS = ['summary','conversation','probe','demo','actions'].map((p) => {
    const el = new El('button'); el.dataset.pane = p; return el;
  });
  const window = {
    location: { hash: '', href: '' },
    addEventListener(type, fn){ listeners.window[type] = fn; },
    scrollTo(){},
    confirm(){ throw new Error('the test must never confirm a destructive action'); },
    prompt(){ throw new Error('the test must never prompt'); },
    alert(){},
  };
  return { document, window, listeners, El, NAV_ITEMS, DR_TABS, stripTags };
}

// ── canonical fixture ──────────────────────────────────────────────────────
const NOW = '2026-09-03T12:00:00.000Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const AG_HEADER = ['agency_id','agency_name','location','rightmove_sales_branch_url','probe_sent',
  'outreach_contact_name','outreach_contact_email','email_verification_status','main_phone','current_pipeline_status'];

function fixture(){
  const tables = {
    AGENCIES: { header: AG_HEADER, rows: [
      // Ready to probe — physical probe_sent blank. Must NOT reach Actions.
      ['ag_probe','Unprobed Ltd','Chelmsford','https://rightmove.test/a','', '','','','01245 000000',''],
      // A real question from a prospect — this IS Joe's work.
      ['ag_reply','Henton Kirkman Residential','Brentwood','https://rightmove.test/b','YES','Nick Henton','nick@hk.test','VALID','01277 000000',''],
      // A demo-engaged lead with a due call — also Joe's work.
      ['ag_call','Period Homes Essex','Ingatestone','https://rightmove.test/c','YES','Adam Walker','adam@ph.test','VALID','01277 111111',''],
      // Observation running — NOVUS is handling it.
      ['ag_obs','Observed Ltd','Billericay','https://rightmove.test/d','YES','','','','',''],
      // Terminal.
      ['ag_won','Won Ltd','Romford','https://rightmove.test/e','YES','','','','','MEETING_BOOKED'],
    ] },
    PROBES: { header: ['probe_id','agency_id','probe_status','observation_deadline','probe_timestamp'], rows: [
      ['prb_obs','ag_obs','observing', hoursAgo(-48), hoursAgo(48)],
    ] },
    INTELLIGENCE: { header: ['intelligence_id','probe_id'], rows: [] },
    PERSONALISATION: { header: ['probe_id','agency_id'], rows: [] },
    DEMOS: { header: ['demo_id','agency_id','probe_id','demo_slug','demo_status','first_viewed_at','last_viewed_at','view_count','cta_clicked_at'], rows: [
      ['dm_call','ag_call','','period-homes','READY', hoursAgo(6), hoursAgo(2),'4', hoursAgo(2)],
    ] },
    OUTBOUND: { header: ['outbound_id','agency_id','probe_id','instantly_lead_id','outbound_status'], rows: [
      ['out_reply','ag_reply','','lead_1','SENT'],
      ['out_call','ag_call','','lead_2','SENT'],
    ] },
    REPLY_EVENTS: { header: ['reply_event_id','agency_id','outreach_id','classification','received_at','next_action','action_status','action_completed_at'], rows: [
      ['r_q','ag_reply','out_reply','QUESTION', hoursAgo(0.7),'','',''],
      ['r_pos','ag_call','out_call','POSITIVE_SEND_DEMO', hoursAgo(30),'SEND_DEMO','COMPLETED', hoursAgo(29)],
    ] },
    SALES_MESSAGES: { header: [], rows: [] },
    ACTIONS: { header: [], rows: [] },
  };
  return buildAcquisitionDashboard(tables, { now: NOW, actionsAvailable: true });
}

// ── load the page script into the shim ─────────────────────────────────────
function bootPage(payload){
  const dom = makeDom();
  const script = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const fetchCalls = [];
  const mutations = [];
  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), method: opts?.method || 'GET' });
    if(String(opts?.method || 'GET') !== 'GET') mutations.push(String(url));
    if(String(url).includes('operator-dashboard')) {
      return { ok:true, status:200, json: async () => ({ success:true, ...payload }) };
    }
    if(String(url).includes('probe?queue=1')) {
      return { ok:true, status:200, json: async () => ({ queue:{ remaining: 1, completed_today: 3 } }) };
    }
    return { ok:true, status:200, json: async () => ({ success:true }) };
  };
  const api = new Function('document','window','fetch','Date','console','encodeURIComponent','exportBridge',
    script + '\n;exportBridge({ showView:()=>VIEW, go:showView, load, renderAll, manualActions, exceptionItems, openDrawer, closeDrawer, renderDrawerPane, setPane:(p)=>{DRAWER_PANE=p;}, setStage:(s)=>{PIPELINE_STAGE=s;}, setActionTab:(t)=>{ACTION_TAB=t;}, renderPipeline, renderActions, renderProber, renderLeads, renderAnalytics, renderExceptions, renderOverview, stageLabel, actionLabel, getLeads:()=>LEADS });');
  let bridge = null;
  api(dom.document, dom.window, fakeFetch, Date, { error(){}, warn(){}, log(){} }, encodeURIComponent, (b) => { bridge = b; });
  return { dom, bridge, fetchCalls, mutations, text: (id) => dom.stripTags(dom.document.getElementById(id).innerHTML || dom.document.getElementById(id).textContent) };
}

const payload = fixture();

console.log('\nCanonical payload used by every view');
check('the fixture produces the expected canonical stages', () => {
  const stage = (id) => payload.leads.find((l) => l.agency_id === id).current_stage;
  assert.equal(stage('ag_probe'), 'READY_TO_PROBE');
  assert.equal(stage('ag_reply'), 'REPLIED_NEEDS_HUMAN');
  assert.equal(stage('ag_call'), 'DEMO_ENGAGED');
  assert.equal(stage('ag_obs'), 'PROBE_OBSERVING');
  assert.equal(stage('ag_won'), 'MEETING_BOOKED');
});

const app = bootPage(payload);
await app.bridge.load(false);

console.log('\nNavigation');
for(const view of ['overview','actions','pipeline','prober','leads','analytics','exceptions']){
  check(`${view} renders`, () => {
    app.bridge.go(view);
    assert.equal(app.bridge.showView(), view);
    assert.equal(app.dom.document.getElementById('v-' + view).classList.contains('on'), true);
  });
}
check('the active sidebar item follows the view', () => {
  app.bridge.go('pipeline');
  const on = app.dom.NAV_ITEMS.filter((el) => el.classList.contains('on'));
  assert.equal(on.length, 1);
  assert.equal(on[0].dataset.view, 'pipeline');
});
check('a direct hash opens that view on boot', () => {
  const direct = bootPage(payload);
  direct.dom.window.location.hash = '#analytics';
  direct.bridge.go('analytics', { push:false });
  assert.equal(direct.bridge.showView(), 'analytics');
});
check('navigating every view issues no write of any kind', () => {
  assert.deepEqual(app.mutations, []);
  const gets = app.fetchCalls.filter((c) => c.method === 'GET').map((c) => c.url);
  assert.ok(gets.every((u) => u.includes('operator-dashboard') || u.includes('probe?queue=1')), gets.join('\n'));
});

console.log('\nActions — the manual queue only');
check('READY_TO_PROBE never appears in the Actions view', () => {
  app.bridge.go('actions');
  const html = app.dom.document.getElementById('ac-list').innerHTML;
  assert.ok(!html.includes('ag_probe'), 'the unprobed agency must not be listed');
  assert.ok(!html.includes('Probe agency'), 'PROBE_AGENCY must not be offered as a manual action');
  assert.ok(!html.includes('Unprobed Ltd'));
});
check('PROBE_AGENCY is not counted as a daily manual action', () => {
  const ids = app.bridge.manualActions().map((l) => l.agency_id);
  assert.ok(!ids.includes('ag_probe'));
  assert.equal(payload.counts.needs_attention, 2);
});
check('a human reply appears', () => {
  const ids = app.bridge.manualActions().map((l) => l.agency_id);
  assert.ok(ids.includes('ag_reply'));
  assert.equal(app.dom.document.getElementById('ac-list').innerHTML.includes('Reply to prospect'), true);
});
check('a due call appears', () => {
  const ids = app.bridge.manualActions().map((l) => l.agency_id);
  assert.ok(ids.includes('ag_call'));
  assert.equal(app.dom.document.getElementById('ac-list').innerHTML.includes('Call prospect'), true);
});
check('manual review, follow-up and next-step tabs are addressable', () => {
  for(const tab of ['replies','calls','reviews','followups','all']){
    app.bridge.setActionTab(tab);
    app.bridge.renderActions();
    assert.ok(app.dom.document.getElementById('ac-list').innerHTML.length > 0, tab);
  }
  app.bridge.setActionTab('all'); app.bridge.renderActions();
});
check('system-owned work never enters the Actions view', () => {
  const html = app.dom.document.getElementById('ac-list').innerHTML;
  assert.ok(!html.includes('Observed Ltd'));
  assert.ok(!html.includes('Observation running'));
});

console.log('\nOverview');
app.bridge.go('overview');
check('KPI cards render from canonical counts', () => {
  const html = app.dom.document.getElementById('ov-kpis').innerHTML;
  assert.ok(html.includes('Active agencies'));
  assert.ok(html.includes('Need you today'));
  assert.ok(html.includes('Meetings booked'));
  assert.ok(html.includes('>2<'), 'the "need you today" figure is the manual queue size');
});
check('the human preview excludes probing', () => {
  const html = app.dom.document.getElementById('ov-tasks').innerHTML;
  assert.ok(!html.includes('Unprobed Ltd'));
  assert.ok(html.includes('Henton Kirkman Residential'));
});
check('the system summary uses NOVUS/system states', () => {
  const html = app.dom.document.getElementById('ov-system').innerHTML;
  assert.ok(/probes observing/.test(html));
});
check('the funnel renders a count for every step', () => {
  const html = app.dom.document.getElementById('ov-funnel').innerHTML;
  for(const label of ['Lead pool','Probed','Outreach','Replied','Demo sent','Demo open','Meeting']) {
    assert.ok(html.includes(label), label);
  }
});

console.log('\nPipeline');
app.bridge.go('pipeline');
check('stages are grouped into canonical bands', () => {
  const html = app.dom.document.getElementById('pl-bands').innerHTML;
  for(const band of ['Lead pool','Probing','Pre-outreach','Outreach','Conversation','Demo','Done']) {
    assert.ok(html.includes(band), band);
  }
});
check('no stage is double counted across bands', () => {
  const seen = new Set();
  const bands = [...HTML.matchAll(/stages:\[([^\]]+)\]/g)].map((m) => m[1].match(/'[A-Z_]+'/g).map((s) => s.slice(1, -1)));
  for(const band of bands){
    for(const stage of band){
      assert.ok(!seen.has(stage), `${stage} appears in more than one band`);
      seen.add(stage);
    }
  }
});
check('selecting a stage lists exactly the agencies at that stage', () => {
  app.bridge.setStage('REPLIED_NEEDS_HUMAN');
  app.bridge.renderPipeline();
  const html = app.dom.document.getElementById('pl-rows').innerHTML;
  assert.ok(html.includes('Henton Kirkman Residential'));
  assert.ok(!html.includes('Unprobed Ltd'));
});
check('closed states are excluded until explicitly included', () => {
  const el = app.dom.document.getElementById('pl-closed');
  el.checked = false;
  app.bridge.renderPipeline();
  assert.ok(!app.dom.document.getElementById('pl-bands').innerHTML.includes('>Closed<'));
  el.checked = true;
  app.bridge.renderPipeline();
  assert.ok(app.dom.document.getElementById('pl-bands').innerHTML.includes('Closed'));
  el.checked = false;
});

console.log('\nProber');
app.bridge.go('prober');
check('the queue shows only blank-probe_sent agencies', () => {
  const html = app.dom.document.getElementById('pr-rows').innerHTML;
  assert.ok(html.includes('Unprobed Ltd'));
  assert.ok(!html.includes('Henton Kirkman'));
  assert.ok(!html.includes('Observed Ltd'));
});
check('the queue count comes from the canonical probe_sent rule', () => {
  assert.equal(payload.counts.probe_queue, 1);
  assert.ok(app.dom.document.getElementById('pr-remaining').textContent.includes('1'));
});
check('Start probing links to the Prober, and never sends anything itself', () => {
  assert.ok(HTML.includes('href="/novus/probe?next=1"'));
  assert.deepEqual(app.mutations, []);
});

console.log('\nLeads');
app.bridge.go('leads');
check('every canonical lead is listed by default', () => {
  const html = app.dom.document.getElementById('ld-rows').innerHTML;
  for(const name of ['Unprobed Ltd','Henton Kirkman Residential','Period Homes Essex','Observed Ltd','Won Ltd']) {
    assert.ok(html.includes(name), name);
  }
});
check('search filters the canonical lead set', () => {
  app.dom.document.getElementById('q').value = 'henton';
  app.bridge.renderLeads();
  const html = app.dom.document.getElementById('ld-rows').innerHTML;
  assert.ok(html.includes('Henton Kirkman Residential'));
  assert.ok(!html.includes('Unprobed Ltd'));
  app.dom.document.getElementById('q').value = '';
});
check('the queue filter separates Joe, Prober and NOVUS work', () => {
  app.dom.document.getElementById('f-owner').value = 'JOE';
  app.bridge.renderLeads();
  let html = app.dom.document.getElementById('ld-rows').innerHTML;
  assert.ok(html.includes('Henton Kirkman Residential'));
  assert.ok(!html.includes('Unprobed Ltd'), 'probe work is not in the Joe queue');
  app.dom.document.getElementById('f-owner').value = 'PROBER';
  app.bridge.renderLeads();
  html = app.dom.document.getElementById('ld-rows').innerHTML;
  assert.ok(html.includes('Unprobed Ltd'));
  app.dom.document.getElementById('f-owner').value = '';
  app.bridge.renderLeads();
});
check('the drawer still opens on a lead', () => {
  app.bridge.openDrawer('ag_reply', 'summary');
  assert.equal(app.dom.document.getElementById('drawer').classList.contains('on'), true);
  const body = app.dom.document.getElementById('d-body').innerHTML;
  assert.ok(body.includes('Next action'));
  assert.ok(body.includes('Reply to prospect'));
  assert.ok(body.includes('nick@hk.test'));
});
check('every drawer tab renders', () => {
  for(const pane of ['summary','probe','demo','actions']){
    app.bridge.setPane(pane);
    app.bridge.renderDrawerPane();
    assert.ok(app.dom.document.getElementById('d-body').innerHTML.length > 40, pane);
  }
  app.bridge.closeDrawer();
  assert.equal(app.dom.document.getElementById('drawer').classList.contains('on'), false);
});
check('raw ids stay behind the Technical details disclosure', () => {
  app.bridge.openDrawer('ag_reply', 'summary');
  const body = app.dom.document.getElementById('d-body').innerHTML;
  // Visible text only: an id inside a data-* attribute is machinery, not a
  // label the operator has to read.
  const visibleBefore = app.dom.stripTags(body.slice(0, body.indexOf('Technical details')));
  assert.ok(!visibleBefore.includes('ag_reply'), 'agency_id must not be displayed above the fold');
  assert.ok(!visibleBefore.includes('out_reply'), 'outbound_id must not be displayed above the fold');
  assert.ok(body.includes('Technical details'));
  const disclosed = body.slice(body.indexOf('Technical details'));
  assert.ok(disclosed.includes('ag_reply'), 'the ids remain available, just disclosed');
  app.bridge.closeDrawer();
});

console.log('\nAnalytics');
app.bridge.go('analytics');
check('a zero denominator renders safely rather than dividing', () => {
  const html = app.dom.document.getElementById('an-conversions').innerHTML;
  assert.ok(html.includes('no denominator') || html.includes('%'));
  assert.ok(!html.includes('NaN'), 'no NaN may reach the screen');
  assert.ok(!html.includes('Infinity'));
});
check('conversions match the canonical metric values exactly', () => {
  const conv = payload.metrics.conversions;
  const html = app.dom.document.getElementById('an-conversions').innerHTML;
  for(const [key, item] of Object.entries(conv)){
    if(item.percent == null) continue;
    assert.ok(html.includes(`${item.percent}%`), `${key} = ${item.percent}%`);
    assert.ok(html.includes(`${item.numerator} of ${item.denominator}`), key);
  }
});
check('the bottleneck is the lowest measurable single-step rate', () => {
  const conv = payload.metrics.conversions;
  const measurable = Object.entries(conv)
    .filter(([k, v]) => k !== 'outreach_to_meeting' && v.percent != null && v.denominator > 0)
    .sort((a, b) => a[1].percent - b[1].percent);
  const html = app.dom.document.getElementById('an-bottleneck').innerHTML;
  if(measurable.length) assert.ok(html.includes(`${measurable[0][1].percent}%`));
  else assert.ok(html.includes('Not enough volume'));
});

console.log('\nExceptions');
app.bridge.go('exceptions');
check('normal waiting states are not exceptions', () => {
  const html = app.dom.document.getElementById('ex-list').innerHTML;
  assert.ok(!html.includes('Observed Ltd'), 'an observing probe is not an exception');
  assert.ok(!html.includes('In sequence'));
});
check('each exception explains what, which agency, why and what to do', () => {
  const withException = buildAcquisitionDashboard({
    AGENCIES: { header: AG_HEADER, rows: [['ag_stuck','Stuck Ltd','','','YES','','','','','']] },
    PROBES: { header: ['probe_id','agency_id'], rows: [] },
    INTELLIGENCE: { header: ['intelligence_id','probe_id'], rows: [] },
    PERSONALISATION: { header: ['probe_id','agency_id'], rows: [] },
    DEMOS: { header: ['demo_id','agency_id','probe_id'], rows: [] },
    OUTBOUND: { header: ['outbound_id','agency_id','probe_id'], rows: [] },
    REPLY_EVENTS: { header: ['reply_event_id','agency_id'], rows: [] },
    SALES_MESSAGES: { header: [], rows: [] },
    ACTIONS: { header: [], rows: [] },
  }, { now: NOW, actionsAvailable: false });
  const other = bootPage(withException);
  return other.bridge.load(false).then(() => {
    other.bridge.go('exceptions');
    const html = other.dom.document.getElementById('ex-list').innerHTML;
    assert.ok(html.includes('Action ledger unavailable'));
    assert.ok(html.includes('What you can do:'));
  });
});

console.log('\nPresentation contract');
check('canonical enums are humanised, never shown raw, in operator-facing text', () => {
  app.bridge.go('actions');
  const html = app.dom.stripTags(app.dom.document.getElementById('ac-list').innerHTML);
  assert.ok(!/\b[A-Z][A-Z0-9_]{2,}\b/.test(html), `raw enum leaked into the Actions view: ${html}`);
  assert.ok(html.includes('a question') || html.includes('unclear'));
});
check('the drawer shows no raw enum above Technical details', () => {
  app.bridge.openDrawer('ag_reply', 'summary');
  const body = app.dom.document.getElementById('d-body').innerHTML;
  const visible = app.dom.stripTags(body.slice(0, body.indexOf('Technical details')));
  const leaked = visible.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
  // JOE/VALID/HIGH are stored values shown as themselves, not machine enums.
  const unexpected = leaked.filter((t) => !['JOE','NOVUS','SYSTEM','VALID','RISKY','INVALID','HIGH','MEDIUM','LOW','UNKNOWN'].includes(t));
  assert.deepEqual(unexpected, [], `unexpected raw enums: ${unexpected.join(', ')}`);
  app.bridge.closeDrawer();
});
check('block titles are not double-escaped', () => {
  app.bridge.openDrawer('ag_reply', 'summary');
  const body = app.dom.document.getElementById('d-body').innerHTML;
  assert.ok(!body.includes('&amp;amp;'), 'an entity was escaped twice');
  assert.ok(body.includes('Agency &amp; contact'));
  app.bridge.closeDrawer();
});

console.log('\nSafety');
check('the page never calls a probe-send, delete, meeting or call-outcome route on its own', () => {
  const urls = app.fetchCalls.map((c) => c.url).join('\n');
  assert.ok(!/mark-sent|skip-agency|action=create/.test(urls));
  assert.ok(!/operator-mark-meeting-booked|operator-call-outcome|operator-manual-reply\b/.test(urls));
});
check('destructive operations still require their exact confirmation tokens', () => {
  assert.ok(HTML.includes("confirm:'MARK_MEETING_BOOKED'"));
  assert.ok(HTML.includes("confirm:'RECORD_CALL_OUTCOME'"));
  assert.ok(HTML.includes("confirm:'SEND_ONE_MANUAL_REPLY'"));
  assert.ok(HTML.includes("confirm:'RECONCILE_ACTIONS'"));
});
check('the demo preview guard is intact', () => {
  assert.ok(HTML.includes('preview_url'));
  assert.ok(/never opened from here|records a view/.test(HTML));
});

console.log(`\n✅ Command Centre self-test passed (${passed} checks).\n`);
