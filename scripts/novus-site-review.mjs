import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base=process.env.NOVUS_SITE_URL || 'http://localhost:4310';
const out='/tmp/novus-site-review'; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const order=['top','gap','how','context','commercial','agency','learning','pilot','faq','contact'];
try {
 for(const [name,width,height] of [['desktop',1440,900],['wide',1920,1080],['tablet',820,1180],['mobile',390,844],['small',320,740],['landscape',844,390]]){
  const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const failed=[];page.on('response',r=>{if(r.status()>=400&&r.url().startsWith(base))failed.push(r.url())});
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  const result=await page.evaluate(()=>({
   width:document.documentElement.scrollWidth,
   sections:[...document.querySelectorAll('main>section')].map(s=>s.id),
   broken:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.querySelector(a.getAttribute('href'))).map(a=>a.outerHTML),
   price:/£|Pricing for|Pricing on request/.test(document.body.innerText),
   obsolete:!!document.querySelector('.journey,[data-operating-loop],.field'),
   ids:[...document.querySelectorAll('[id]')].map(el=>el.id),
   overflowing:[...document.querySelectorAll('main p,main h1,main h2,main h3,main li,main .btn,.orbit-label')].filter(el=>{const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(el=>el.textContent),
   minDiagramFont:Math.min(...[...document.querySelectorAll('.signal,.opportunity-example p,.agency-flow__outputs li,.orbit-label')].map(el=>parseFloat(getComputedStyle(el).fontSize)))
  }));
  assert.ok(result.width<=width,`${name} overflow`);assert.deepEqual(result.overflowing,[],`${name} content clipped`);
  assert.deepEqual(result.sections,order);assert.deepEqual(result.broken,[]);assert.equal(result.price,false);assert.equal(result.obsolete,false);
  assert.equal(new Set(result.ids).size,result.ids.length);assert.ok(result.minDiagramFont>=11);
  assert.equal(await page.locator('.signal').count(),16);assert.equal(await page.locator('.opportunity-example').count(),4);
  assert.equal(await page.locator('.commercial-effects>li').count(),4);assert.equal(await page.locator('.work-split li').count(),12);
  assert.equal(await page.locator('.pilot__stages>li').count(),3);
  assert.equal(await page.locator('.faq__item').count(),6);
  assert.equal(await page.locator('.faq__item[open]').count(),0,'FAQ starts collapsed');
  const questions=page.locator('.faq__item summary');
  for(let i=0;i<6;i++){
   await questions.nth(i).click();
   assert.equal(await page.locator('.faq__item[open]').count(),1,'one answer open');
   assert.equal(await page.locator('.faq__item').nth(i).getAttribute('open'),'');
   assert.ok(await questions.nth(i).evaluate(el=>el.getBoundingClientRect().height>=44));
   assert.ok(await page.locator('.faq__answer').nth(i).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&parseFloat(getComputedStyle(el).fontSize)>=15}));
  }
  await questions.last().press('Enter');
  assert.equal(await page.locator('.faq__item[open]').count(),0,'keyboard collapse');
  await questions.first().press('Space');
  assert.equal(await page.locator('.faq__item[open]').count(),1,'keyboard open');
  if(name==='desktop'||name==='mobile')await page.locator('#faq').screenshot({path:`${out}/${name}-faq-open.png`,style:'.hdr{visibility:hidden!important}'});
  await questions.first().click();
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  assert.equal(await page.locator('.hero__actions a').first().getAttribute('href'),'#how');
  for(const a of await page.locator('a[href*="calendly"]').all()) assert.equal(await a.getAttribute('href'),'https://calendly.com/joe-getnovus/10min');
  if(width<=480){
   const core=await page.locator('.applied-map__core').boundingBox(), first=await page.locator('.opportunity-example').first().boundingBox();
   assert.ok(core.y+core.height<=first.y+1,'mobile understanding must come before opportunities');
  }
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});
  if(name==='desktop'||name==='mobile'){
   await page.screenshot({path:`${out}/${name}-hero.png`});
   for(const section of ['gap','how','context','agency','learning','pilot']) await page.locator('#'+section).screenshot({path:`${out}/${name}-${section}.png`,style:'.hdr{visibility:hidden!important}'});
  }
  await page.locator('.hero__actions a').first().click();assert.equal(await page.evaluate(()=>location.hash),'#how');
  if(width<901){
   await page.locator('.hdr__burger').click();assert.equal(await page.locator('.hdr__burger').getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Escape');assert.equal(await page.locator('.hdr__burger').getAttribute('aria-expanded'),'false');
   await page.locator('.hdr__burger').click();await page.locator('#menu a[href="#pilot"]').click();assert.equal(await page.locator('#menu').getAttribute('aria-hidden'),'true');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  console.log(`${name} ${width}x${height}: narrative, links, legible diagrams and overflow checks passed`);await page.close();
 }
 const motion=await browser.newPage({viewport:{width:1440,height:900}});
 await motion.goto(base);await motion.evaluate(()=>document.fonts.ready);
 for(const section of order){
  await motion.locator('#'+section).scrollIntoViewIfNeeded();
  await motion.waitForTimeout(160);
 }
 assert.equal(await motion.locator('[data-flow].is-connected').count(),3,'every diagram enters once');
 assert.equal(await motion.locator('[data-reveal]:not(.is-in)').count(),0,'all sections reveal through ordinary scrolling');
 const animations=await motion.evaluate(()=>document.getAnimations().map(a=>a.effect.getTiming()));
 assert.ok(animations.every(a=>a.iterations===1),'no repeating animation');
 await motion.locator('#learning').scrollIntoViewIfNeeded();
 await motion.waitForTimeout(9400);
 assert.equal(await motion.locator('.orbit-flow').evaluate(el=>getComputedStyle(el).strokeDashoffset),'0px','feedback path completes');
 await motion.locator('.faq__item summary').first().click();
 await motion.waitForTimeout(270);
 assert.equal(await motion.locator('.faq__item[open]').count(),1);
 await motion.locator('.faq__item summary').first().evaluate(el=>{el.click();el.click();el.click()});
 await motion.waitForTimeout(270);
 assert.equal(await motion.locator('.faq__item[open]').count(),0,'rapid toggling settles closed');
 await motion.locator('.faq__item summary').first().evaluate(el=>el.click());
 await motion.emulateMedia({reducedMotion:'reduce'});
 await motion.waitForTimeout(50);
 assert.equal(await motion.locator('[data-flow].is-connected').count(),0,'changing motion preference settles diagrams');
 console.log('One-pass diagrams, full reveals, completed feedback and live reduced-motion preference passed');
 await motion.close();
 const nojs=await browser.newPage({javaScriptEnabled:false,viewport:{width:390,height:844}});await nojs.goto(base);
 for(const selector of ['.hero h1','.human__understands','.agency-flow__outputs','.opportunity-example','.learning__promise','.pilot__stages']){
  assert.equal(await nojs.locator(selector).first().isVisible(),true);
  assert.equal(await nojs.locator(selector).first().evaluate(el=>getComputedStyle(el).opacity),'1');
 }
 await nojs.locator('.faq__item summary').first().click();
 assert.equal(await nojs.locator('.faq__item[open]').count(),1,'native FAQ works without scripts');
 assert.equal(await nojs.locator('.faq__answer').first().isVisible(),true);
 await nojs.screenshot({path:`${out}/no-js.png`,fullPage:true});
 console.log('No-JS fallback preserves the complete narrative and diagrams');
} finally {await browser.close();}
