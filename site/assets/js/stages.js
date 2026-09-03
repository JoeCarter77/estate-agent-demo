/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — THE PRODUCT CHAPTER

   Understand, Act and Optimise are one chapter operating on one surface. As
   the reader moves down the three stages, the panel beside them changes what
   it is showing rather than being replaced by another section.

   This is a state machine driven by reading position, not a tab bar: there is
   nothing to click, and nothing here claims to be navigation — the header's
   scrollspy remains the only thing on the page that says where you are.

   Below the breakpoint where the sticky pairing is dropped there is nothing
   to swap against, so the CSS shows all three views in sequence and this
   machine stands down — including if the window is resized across it.
   ═══════════════════════════════════════════════════════════════════════════ */

import { STAGES } from './config.js';

/* The panel's title names what is currently on screen. */
const TITLES = { 1: 'Intelligence', 2: 'Action', 3: 'Optimisation' };

/* The panel only swaps where it is sticky beside the copy. This must match the
   breakpoint in sections.css that drops the two-column pairing. */
const PAIRED = '(min-width: 1081px)';

export function initStages(){
  const host = document.querySelector('[data-stages]');
  if(!host) return;

  const stages = Array.from(host.querySelectorAll('.stage'));
  const views = Array.from(host.querySelectorAll('.view'));
  const title = host.querySelector('[data-stage-title]');
  if(!stages.length || !views.length) return;

  const show = (n) => {
    if(host.dataset.stage === String(n)) return;
    host.dataset.stage = String(n);
    stages.forEach(s => s.classList.toggle('is-on', s.dataset.s === String(n)));
    views.forEach(v => v.classList.toggle('is-on', v.dataset.view === String(n)));
    if(title && TITLES[n]) title.textContent = TITLES[n];
  };

  // No observer: leave stage 1 lit. Every stage's copy is still readable and
  // the first view is a true, complete state of the panel.
  if(!('IntersectionObserver' in window)){
    stages.forEach(s => s.classList.add('is-on'));
    views.forEach(v => v.classList.add('is-on'));
    return;
  }

  const paired = window.matchMedia(PAIRED);

  // Stacked layout: every stage and every view is simply on.
  const standDown = () => {
    stages.forEach(s => s.classList.add('is-on'));
    views.forEach(v => v.classList.add('is-on'));
  };

  const visible = new Set();

  const io = new IntersectionObserver((entries) => {
    if(!paired.matches) return;
    for(const entry of entries){
      if(entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    // The topmost stage in the band wins, so reading order decides the panel.
    const winner = stages.find(s => visible.has(s));
    if(winner) show(Number(winner.dataset.s));
  }, { rootMargin: STAGES.rootMargin, threshold: STAGES.threshold });

  const sync = () => {
    if(paired.matches){
      stages.forEach(s => io.observe(s));
      host.dataset.stage = '';
      show(1);
    }else{
      stages.forEach(s => io.unobserve(s));
      standDown();
    }
  };

  paired.addEventListener('change', sync);
  sync();
}
