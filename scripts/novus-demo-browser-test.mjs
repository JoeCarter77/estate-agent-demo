import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base=process.env.NOVUS_PREVIEW_URL || 'http://127.0.0.1:4311';
const out='/tmp/novus-demo-qa';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true, channel:'chrome'});
// Drive a pinned track to a fraction of its own scroll range, so a beat can be
// asserted at the point it is meant to be readable.
const seek=(page,track,pin,f)=>page.evaluate(([t,p,frac])=>{
  const el=document.querySelector(t), pinned=document.querySelector(p);
  const head=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head'))||80;
  scrollTo(0, el.offsetTop + (el.offsetHeight - pinned.offsetHeight)*frac - head);
},[track,pin,f]);
const varOf=(page,sel,name)=>page.locator(sel).evaluate((el,n)=>Number(getComputedStyle(el).getPropertyValue(n)),name);
try {
for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844],['small-mobile',320,740]]) {
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/home-27?preview=1');await page.locator('#main').waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);
 await page.locator('#property-photo').evaluate(img=>img.decode());
 await page.evaluate(()=>document.documentElement.style.scrollBehavior='auto');
 assert.match(await page.title(),/HOME Partnership/);
 assert.match(await page.locator('#enquiry-title').innerText(),/Centenary Way/);
 assert.ok(await page.locator('#property-photo').evaluate(img=>img.naturalWidth>0));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflow');
 // The listing is personalisation evidence, not a hero image: capped in both
 // axes, never near viewport height, and never outweighing the headline.
 const shot=await page.evaluate(()=>{
   const v=document.querySelector('.property-visual').getBoundingClientRect();
   const el=document.querySelector('#enquiry-title'), h1=el.getBoundingClientRect();
   return {w:v.width,h:v.height,h1w:h1.width,h1size:parseFloat(getComputedStyle(el).fontSize)};
 });
 if (width>1050) {
   // Materially smaller than a hero: recognition evidence, not the subject.
   assert.ok(shot.w>=480 && shot.w<=620,`${name}: property ${Math.round(shot.w)}px wide`);
   assert.ok(shot.h>=340 && shot.h<=430,`${name}: property ${Math.round(shot.h)}px tall`);
   // co-equal headline: a full type size and a column at least as wide as the image
   assert.ok(shot.h1size>=40,`${name}: headline only ${shot.h1size}px`);
   assert.ok(shot.h1w>=shot.w*0.95,`${name}: headline column ${Math.round(shot.h1w)}px vs image ${Math.round(shot.w)}px`);
 }
 assert.ok(shot.h<=height*0.55,`${name}: property is ${Math.round(shot.h/height*100)}% of the viewport`);
 await page.screenshot({path:`${out}/${name}-opening.png`});

 // Two primary facts. The contact address is supporting metadata under the
 // declaration and must never read as the property being sold.
 assert.match(await page.locator('#fact-buyer').innerText(),/Centenary Way/);
 assert.ok(await page.locator('#fact-seller').isVisible());
 assert.match(await page.locator('#fact-seller .fact-value').innerText(),/^Property to sell$/);
 const locality=await page.locator('#fact-locality').innerText();
 assert.match(locality,/^Current address provided: Billericay/);
 assert.match(locality,/not necessarily the property being sold/i);
 // supporting metadata, never the weight of the declaration itself
 const decl=await page.locator('#fact-seller .fact-value').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 const addr=await page.locator('#fact-locality').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 assert.ok(addr<decl-3,'the contact address must not carry the declaration\'s weight');
 assert.equal(await page.locator('.fact-row > li').count(),2,'no third equal-weight column');
 assert.match(await page.locator('#timeline li').first().innerText(),/Enquiry sent/);

 // A clear section label orients the reader without another giant headline.
 assert.match(await page.locator('.section-label').innerText(),/The enquiry/i);
 // The raw record is opt-in: present, collapsed, and never shown by default.
 assert.ok(await page.locator('#original-enquiry').isVisible(),name+' original-enquiry toggle present');
 assert.equal(await page.locator('#original-enquiry').evaluate(el=>el.hasAttribute('open')),false,name+' collapsed by default');
 assert.ok(!(await page.locator('.original-enquiry-body').isVisible()),name+' raw record hidden until clicked');
 await page.locator('#original-enquiry summary').click();await page.waitForTimeout(150);
 assert.ok(await page.locator('.original-enquiry-body').isVisible(),name+' raw record revealed on click');
 const recordText=(await page.locator('#probe-message').isVisible())?await page.locator('#probe-message').innerText():await page.locator('#enquiry-record').innerText();
 assert.match(recordText,/property to sell|Rightmove/i,name+' original enquiry content visible after click');
 await page.locator('#original-enquiry summary').click();await page.waitForTimeout(150); // close again

 // ── the static transition: hard-coded, always visible, never fades ───────
 await page.locator('.transition').evaluate(el=>el.scrollIntoView({block:'center'}));await page.waitForTimeout(250);
 assert.match(await page.locator('#transition-title').innerText(),/dealt with perfectly/);
 assert.equal(await page.locator('.transition-examples span').count(),4);
 assert.match(await page.locator('.transition-but').innerText(),/how much more value could exist/);
 assert.match(await page.locator('#transition-main').innerText(),/entire agency/);
 for (const sel of ['#transition-title','.transition-examples','.transition-but','#transition-main']) {
  assert.ok(await page.locator(sel).isVisible(),name+' transition '+sel);
  const op=await page.locator(sel).evaluate(el=>Number(getComputedStyle(el).opacity));
  assert.ok(op>.98,`${name}: ${sel} is not fully opaque — static copy must never fade`);
 }
 await page.screenshot({path:`${out}/${name}-transition.png`});
 // scroll deep into the zoom-out and back: the transition must still be
 // completely there, never removed or faded by the scroll-driven sequence
 // that follows it.
 await seek(page,'#zoom','.zoom-stage',.7);await page.waitForTimeout(120);
 await page.locator('.transition').evaluate(el=>el.scrollIntoView({block:'center'}));await page.waitForTimeout(120);
 assert.ok(await page.locator('#transition-main').isVisible(),name+' transition persists after scrolling past it');
 assert.ok(Number(await page.locator('#transition-main').evaluate(el=>getComputedStyle(el).opacity))>.98,name+' transition-main stays opaque');

 // ── the zoom-out: the card sits at rest, then recedes as the pool and the
 // commercial question take its place ─────────────────────────────────────
 await seek(page,'#zoom','.zoom-stage',0);await page.waitForTimeout(140);
 assert.ok(await varOf(page,'.zoom-stage','--seed')>.95,name+' card at rest on arrival');
 assert.ok(await varOf(page,'.zoom-stage','--seed-scale')>.95,name+' card full size on arrival');
 await page.screenshot({path:`${out}/${name}-card-rest.png`});
 await seek(page,'#zoom','.zoom-stage',.30);await page.waitForTimeout(140);
 const midSeed=await varOf(page,'.zoom-stage','--seed'), midScale=await varOf(page,'.zoom-stage','--seed-scale');
 assert.ok(midSeed>.05 && midSeed<.95,`${name}: card mid-recede opacity ${midSeed}`);
 assert.ok(midScale>.05 && midScale<.95,`${name}: card mid-recede scale ${midScale}`);
 // it dissolves AS it shrinks — opacity and scale must move together, never
 // a solid card shrinking first and only then vanishing.
 assert.ok(Math.abs(midSeed-midScale)<.35,`${name}: card must fade and shrink together (opacity ${midSeed} vs scale ${midScale})`);
 await seek(page,'#zoom','.zoom-stage',.60);await page.waitForTimeout(160);
 assert.ok(await varOf(page,'.zoom-stage','--seed')<.05,name+' card gone by mid-track');
 assert.ok(await varOf(page,'.zoom-stage','--field')>.9,name+' demand field settled');
 await page.screenshot({path:`${out}/${name}-field.png`});
 await seek(page,'#zoom','.zoom-stage',.93);await page.waitForTimeout(160);
 assert.ok(await varOf(page,'.zoom-stage','--seed-scale')<.3,name+' card receded');
 assert.ok(await varOf(page,'.zoom-stage','--question')>.9,name+' question landed');
 // lands and HOLDS — it must not already be leaving by the very end of the track
 await seek(page,'#zoom','.zoom-stage',1);await page.waitForTimeout(140);
 assert.ok(await varOf(page,'.zoom-stage','--question')>.9,name+' question holds to the end of the track');
 // the question must be premium, not enormous
 const qs=await page.locator('#commercial-question').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 assert.ok(qs<=(width>1050?50:34),`${name} question ${qs}px too large`);
 if (width>=1440) {
   const lines=await page.locator('#commercial-question').evaluate(el=>
     Math.round(el.getBoundingClientRect().height/parseFloat(getComputedStyle(el).lineHeight)));
   assert.ok(lines<=3,`${name}: question wraps to ${lines} lines`);
 }
 await page.screenshot({path:`${out}/${name}-question.png`});

 // ── the process is legible on arrival, then changes state ────────────────
 const pinnedProcess=width>1050;
 await seek(page,'#method-track','.method-pin',.02);await page.waitForTimeout(220);
 assert.equal(await page.locator('.panel').count(),4);
 assert.match(await page.locator('.branch-novus').innerText(),/NOVUS acts/i);
 assert.match(await page.locator('.branch-team').innerText(),/Your team/i);
 await page.screenshot({path:`${out}/${name}-method.png`});
 if (pinnedProcess) {
  // all four stage labels readable immediately, and readable while inactive
  assert.equal(await page.locator('.step').count(),4);
  for (let i=0;i<4;i++) {
    const st=page.locator('.step').nth(i);
    assert.ok(await st.isVisible(),name+' step '+i);
    const o=await st.evaluate(el=>Number(getComputedStyle(el).opacity));
    assert.ok(o>.9,`${name}: inactive step ${i} faded to ${o}`);
  }
  assert.ok(await page.locator('.panel').nth(0).evaluate(el=>el.classList.contains('on')),name+' opens on Understand');
  // the whole process must fit one viewport
  const box=await page.locator('.method-pin .frame').boundingBox();
  assert.ok(box.height<=height-40,`${name}: process is ${Math.round(box.height)}px in a ${height}px viewport`);
  for (const [frac,want] of [[.32,1],[.56,2],[.85,3]]) {
   await seek(page,'#method-track','.method-pin',frac);await page.waitForTimeout(240);
   assert.ok(await page.locator('.step').nth(want).evaluate(el=>el.classList.contains('on')),name+' step '+want+' at '+frac);
   assert.ok(await page.locator('.panel').nth(want).evaluate(el=>el.classList.contains('on')),name+' panel '+want);
   assert.ok(await page.locator('#method-title').isVisible(),name+' headline stays with the process');
   if (want===2) assert.ok(await page.locator('.branch-novus').isVisible(),name+' branch shown on Act');
   if (want===3) assert.ok(await page.locator('.loop-note').isVisible(),name+' loop shown on Learn');
  }
  await page.screenshot({path:`${out}/${name}-method-learn.png`});
 } else {
  // no pin, no swapping: every stage and its copy readable at once
  assert.equal(await page.locator('.steps').isVisible(),false);
  for (let i=0;i<4;i++) {
    assert.ok(await page.locator('.panel').nth(i).isVisible(),name+' panel '+i);
    assert.ok(await page.locator('.panel-step').nth(i).isVisible(),name+' panel step '+i);
  }
 }

 // ── the result intensifies into fee income ───────────────────────────────
 await page.locator('.result').evaluate(el=>el.scrollIntoView({block:'start'}));await page.waitForTimeout(300);
 assert.equal(await page.locator('.rung').count(),5);
 assert.match(await page.locator('.rung-payoff h3').innerText(),/More fee income/i);
 assert.match(await page.locator('.ladder-note').innerText(),/not a guaranteed outcome/i);
 await page.screenshot({path:`${out}/${name}-result.png`});
 await page.locator('.qualification').evaluate(el=>el.scrollIntoView({block:'start'}));await page.waitForTimeout(300);
 assert.ok(await varOf(page,'#ladder','--flow')>.9,name+' ladder flow');
 await page.screenshot({path:`${out}/${name}-cta.png`});
 // nothing may follow the CTA, and the primary state outweighs the quiet one
 assert.equal(await page.locator('.state-in > *:last-child').evaluate(el=>el.tagName),'A');
 const giveUs=await page.locator('.give-us').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 const quiet=await page.locator('.state-out .state-a').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 assert.ok(giveUs>quiet*1.6,`${name}: "Give us 20 minutes" (${giveUs}px) must dominate the quiet state (${quiet}px)`);
 assert.match(await page.locator('#qualification-title em').innerText(),/more value/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflow after scroll');

 await page.locator('.qualification [data-book]').click();await page.locator('#booking').waitFor({state:'visible'});
 assert.match(await page.locator('#calendar').getAttribute('src'),/^https:\/\/calendly.com\/joe-getnovus\/10min\?/);
 await page.emulateMedia({reducedMotion:'reduce'}); await page.waitForTimeout(120);
 assert.equal(await page.locator('.zoom-stage').evaluate(el=>el.style.length),0);
 assert.equal(await page.locator('.step.on').count(),0);
 assert.deepEqual(errors,[]);await page.close();console.log(name+': facts, beats, question, process, result, CTA and runtime passed');
}
for(const route of ['preview-sparse','preview-strong']) {
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await page.goto(base+'/'+route+'?preview=1');await page.locator('#main').waitFor({state:'visible'});
 assert.equal(await page.locator('#timeline li').count(),route==='preview-sparse'?1:4);
 if(route==='preview-strong'){await page.locator('#more-events summary').click();assert.equal(await page.locator('#timeline-more li').count(),2);await page.locator('#original-enquiry summary').click();assert.ok(await page.locator('#probe-message').isVisible());}
 else {assert.ok(await page.locator('#message-unavailable').isVisible());
       assert.ok(await page.locator('#fact-seller').isHidden(),'no seller claim without a declaration');
       assert.equal(await page.locator('.fact-row > li:visible').count(),1);}
 // reduced motion shows the whole narrative statically, in order and NOT
 // stacked on top of itself — visibility alone would not catch an overlap.
 const boxes=[];
 for (const sel of ['#transition-title','#transition-main','#commercial-question','.rung-payoff h3']) {
   assert.ok(await page.locator(sel).isVisible(),route+' static '+sel);
   boxes.push([sel,await page.locator(sel).boundingBox()]);
 }
 for (let i=1;i<4;i++) {
   const [pn,a]=boxes[i-1],[cn,b]=boxes[i];
   assert.ok(a.y+a.height<=b.y+1,`${route}: ${pn} overlaps ${cn} in static mode`);
 }
 assert.equal(await page.locator('.panel').count(),4);
 assert.ok(await page.locator('body').evaluate(el=>el.classList.contains('static-zoom')));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+' overflow');
 assert.ok(!/missed|failed|lost revenue|Needs review|should have/i.test(await page.locator('#main').innerText()));
 await page.close();console.log(route+': sparse/strong handling and reduced motion passed');
}
const p=await browser.newPage();
for (const path of ['/demo/home-27?preview=1','/demo.html?slug=home-27&preview=1']) { await p.goto(base+path); await p.locator('#main').waitFor({state:'visible'}); assert.match(await p.title(),/HOME Partnership/); }
console.log('Legacy path and query-string route aliases passed');
await p.goto(base+'/does-not-exist');await p.locator('#retry').waitFor({state:'visible'});assert.ok(await p.locator('#main').isHidden());console.log('Invalid route: recoverable error state passed');
} finally {await browser.close();}
