import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildDemoFacts, loadDemoFacts } from '../lib/demo-facts.mjs';
const row={demo_slug:'test-1',probe_id:'p1',agency_id:'a1',agency_name:'Test Agency',property_address:'12,Example Road, Town',property_image_url:'https://example.com/listing.jpg',enquiry_at:'2026-08-17T22:39:00Z',seller_declared:'yes',observed_problem:'Your team failed',commercial_implication:'Lost revenue',reading:{credit:'Generated interpretation'}};
const probe={probe_id:'p1',enquiry_text:'Hello — I have a flat to sell. Can I view this property?',probe_timestamp:row.enquiry_at};
const touch=(id,changes={})=>({communication_id:id,probe_id:'p1',agency_id:'a1',direction:'inbound',channel:'email',match_status:'matched',occurred_at:'2026-08-18T09:42:00Z',...changes});
const facts=buildDemoFacts(row,probe,[touch('1'),touch('1'),touch('2',{channel:'phone',occurred_at:'2026-08-18T10:03:00Z'}),touch('3',{match_status:'deleted'}),touch('4',{probe_id:'someone-else'}),touch('5',{direction:'outbound'}),touch('6',{match_status:'ambiguous'}),touch('7',{occurred_at:'bad'}),touch('8',{agency_id:'someone-else'}),touch('9',{occurred_at:'2026-08-15T10:00:00Z'})]);
assert.equal(facts.probe_message,probe.enquiry_text,'exact punctuation preserved');
assert.equal(facts.property_street,'12 Example Road');
assert.equal(facts.seller_declared,true);
assert.deepEqual(facts.communication_events.map(e=>e.label),['Enquiry sent','Email received','Call recorded']);
// The contact address is a constant of the enquiry we send. It is surfaced as
// a current address and must NEVER be presented as the property being sold.
assert.equal(facts.contact_locality,'Billericay');
assert.equal(facts.contact_locality_note,'Address supplied with the enquiry');
assert.ok(!/\bsell/i.test(facts.contact_locality),'the locality is a place, never a claim');
assert.ok(!/to sell|selling|vendor/i.test(facts.contact_locality_note));
assert.ok(!/failed|Lost revenue|Generated interpretation/.test(JSON.stringify(facts)));
assert.equal(buildDemoFacts(row,{enquiry_text:'I have nothing to sell.'}).seller_declared,false);
assert.equal(buildDemoFacts(row,{enquiry_text:'I have a property but do not need to sell it.'}).seller_declared,false);
const historical=buildDemoFacts(row,{enquiry_text:'Rightmove property enquiry. Declared: has a property to sell, yes.'});
assert.equal(historical.probe_message,'');assert.ok(historical.enquiry_record);assert.equal(historical.seller_declared,true);
const sparse=buildDemoFacts({...row,property_image_url:'javascript:alert(1)',property_url:'javascript:alert(1)'},{},[]);
assert.equal(sparse.property_image_url,'');assert.equal(sparse.property_url,'');assert.equal(sparse.communication_events.length,1);
const fallbacks=await loadDemoFacts({getRecords:async()=>{throw new Error('source unavailable');}},row);
assert.equal(fallbacks.agency_name,row.agency_name);assert.equal(fallbacks.communication_events.length,1);
const strong=JSON.parse(await readFile(new URL('./fixtures/strong-handling-probe.json',import.meta.url)));
const wellHandled=buildDemoFacts({...row,...strong.intelligence},strong.probe,[]);
assert.ok(wellHandled.seller_declared);assert.ok(!/judgement|missed|failed|unresolved|should have/i.test(JSON.stringify(wellHandled)));
const html=await readFile(new URL('../demo.html',import.meta.url),'utf8');
const js=await readFile(new URL('../site/assets/js/demo.js',import.meta.url),'utf8');
assert.ok(!/demo\.(?:reading|handling_quality|unresolved_context|observed_problem|commercial_implication|grade|verdict_label)/.test(js));
assert.ok(!/Needs review|What your team did|What was still never established|Enquiries repeatedly stalling/.test(html));

// ── narrative contract ────────────────────────────────────────────────────
// Section order carries the argument: real enquiry → the enquiry recedes →
// the commercial question → NOVUS → the result → qualification.
const order=['id="enquiry-title"','id="transition-title"','id="transition-main"','id="commercial-question"','What NOVUS does','id="result-title"','id="qualification-title"'].map(id=>html.indexOf(id));
// The demo stylesheet redefines tokens tokens.css owns and reuses generic site
// class names, so it must be scoped where it cannot reach the public site.
assert.match(html,/<html[^>]*class="demo-page"/,'demo.html carries the scope class');
assert.deepEqual(order,[...order].sort((a,b)=>a-b),'section order');
assert.ok(order.every(i=>i>=0),'every section present');

// Exact briefed copy, including the deliberate "may have".
for (const line of [
  'This enquiry may have been dealt with perfectly.',
  'Fast response','Consistent follow-up','Seller position identified and questioned','Buyer progressed',
  'These are examples of what strong handling may include.',
  'But one well-handled enquiry doesn\u2019t tell you how much more value could exist across the rest of your enquiries and database.',
  'So what\u2019s happening across your entire agency?',
  'all the commercial value you could',
  'Where does that extra value sit',
  'Get more business from the demand your agency already has.',
  'Understand the full picture','Identify where the value is',
  'Take the best next action','Learn what works',
  'NOVUS acts','Your team',
  'The result','More fee income',
  'Already confident you\u2019re getting everything possible?','NOVUS probably isn\u2019t for you.',
  'Not completely sure?','Give us 20 minutes.',
  'View original enquiry','The enquiry',
]) assert.ok(html.includes(line),'missing briefed copy: '+line);

// The transition copy is now hard-coded, static content OUTSIDE the pinned
// zoom stage — it must never live inside the scroll-scrubbed track again.
const stageHtml=html.slice(html.indexOf('<div class="zoom-stage">'),html.indexOf('</section>',html.indexOf('zoom-stage')));
for (const gone of ['beat-1','beat-2','beat-3','transition-title','transition-main'])
  assert.ok(!stageHtml.includes(gone),'static transition copy leaked into the pinned zoom stage: '+gone);
assert.ok(stageHtml.includes('enquiry-seed'),'the enquiry card must still open the zoom-out');
assert.ok(!/class="bridge/.test(html),'the standalone bridge section is gone');
// The static transition section sits between the enquiry and the zoom-out,
// in that exact order, and is never nested inside the pinned stage.
const enquiryIdx=html.indexOf('id="enquiry"');
const transitionIdx=html.indexOf('class="transition"');
const zoomStageIdx=html.indexOf('zoom-stage');
assert.ok(enquiryIdx<transitionIdx && transitionIdx<zoomStageIdx,'THE ENQUIRY → static transition → zoom-out order');
// The raw record is opt-in, never on by default.
assert.match(html,/<details class="original-enquiry" id="original-enquiry" hidden>/,'raw record starts hidden');
assert.ok(html.indexOf('<summary>View original enquiry</summary>')>html.indexOf('id="original-enquiry"'),'summary sits inside the disclosure');
// All four stage labels and all four explanations ship in the markup, so the
// process is legible on arrival rather than assembled by scroll.
for (const label of ['Understand','Identify','Act','Learn'])
  assert.ok(new RegExp('<span>'+label+'</span>').test(html),'missing step label: '+label);
assert.equal((html.match(/class="panel"/g)||[]).length,4);
assert.equal((html.match(/class="panel-step"/g)||[]).length,4);

// The remembered phrase is the only thing marked for NOVUS blue in the question.
assert.ok(/<em>all the commercial value you could<\/em>/.test(html),'blue phrase');

// Compressed away in this pass, and must not creep back.
for (const gone of [
  'Not more lead generation','A focused look at whether',
  'This demo isn\u2019t about whether','Zoom out from that one enquiry',
  'why this probe matters','commercial context',
  'Responded quickly','Picked up the seller opportunity',
  'But one enquiry is only one part of the picture',
  'Connect the full picture','Find where more business can be created',
  'We used this enquiry as the starting point for your demo.',
  'But one enquiry tells you nothing about whether the rest of your demand is producing everything it could.',
]) assert.ok(!html.includes(gone),'removed copy returned: '+gone);

// Nothing on the page requires the agency to admit a failure.
assert.ok(!/\b(?:missed|failed|should have|only took|too slow|mishandled)\b/i.test(html.replace(/<!--[\s\S]*?-->/g,'')),'no accusation');
// The result is a direction, never a promise.
assert.ok(/not a guaranteed outcome/.test(html),'result is not framed as a guarantee');
assert.ok(html.indexOf('commercial-question')<html.indexOf('What NOVUS does'));
console.log('Demo factual contract: exact text, historical records, safe URLs, matched chronology, contact-address rule, sparse sources and strong handling passed.');
console.log('Demo narrative contract: section order, briefed copy, removed copy and no-accusation rule passed.');

// Exercise the actual API, including backwards-compatible payloads and gates.
const { default: handler } = await import('../api/demo.js');
const { __setRepoForTests } = await import('../lib/sheets.mjs');
const apiRow={...row,demo_status:'ready'};
const header=Object.keys(apiRow);
const reads=[];
__setRepoForTests({getTable:async()=>({header,rows:[header.map(k=>apiRow[k])]}),getRecords:async tab=>{reads.push(tab);return tab==='PROBES'?[{obj:probe}]:[{obj:touch('1')}];}});
const response=()=>({statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
try {
 let res=response();await handler({method:'GET',query:{slug:'test-1',facts:'1',preview:'1'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.demo.probe_message,probe.enquiry_text);
 assert.ok(!('reading' in res.body.demo));assert.deepEqual(reads.sort(),['COMMUNICATIONS','PROBES']);
 reads.length=0;res=response();await handler({method:'GET',query:{slug:'test-1',preview:'1'}},res);
 assert.equal(res.statusCode,200);assert.ok('reading' in res.body.demo);assert.equal(reads.length,0);
 apiRow.demo_status='archived';res=response();await handler({method:'GET',query:{slug:'test-1',facts:'1',preview:'1'}},res);assert.equal(res.statusCode,404);
 apiRow.demo_status='needs_review';res=response();await handler({method:'GET',query:{slug:'test-1',facts:'1'}},res);assert.equal(res.statusCode,404);
 console.log('Demo API: factual payload, legacy compatibility, archive and readiness gates passed.');
} finally {__setRepoForTests(null);}
