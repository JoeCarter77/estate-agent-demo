/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — REVEAL
   One IntersectionObserver for the whole page. A container marked
   [data-reveal] gains .is-in when it enters, and any .reveal-child inside it
   (but not inside a nested [data-reveal]) is given a stagger delay.

   The reveal is a transition FROM a shifted state TO the real composition, so
   if it never fires — no JS, no IntersectionObserver, reduced motion — the
   page still lands correctly. See base.css.
   ═══════════════════════════════════════════════════════════════════════════ */

import { REVEAL } from './config.js';

export function initReveal(){
  const groups = document.querySelectorAll('[data-reveal]');
  if(!groups.length) return;

  // No observer available: show everything immediately rather than hiding it.
  if(!('IntersectionObserver' in window)){
    groups.forEach(g => g.classList.add('is-in'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for(const entry of entries){
      if(!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);           // reveal is a one-way door
    }
  }, { rootMargin: REVEAL.rootMargin, threshold: REVEAL.threshold });

  for(const group of groups){
    const step = Number(group.dataset.stagger || REVEAL.stagger);

    // Children belonging to a nested [data-reveal] are that group's business.
    const kids = Array.from(group.querySelectorAll('.reveal-child'))
      .filter(el => el.closest('[data-reveal]') === group);

    kids.forEach((el, i) => {
      el.style.setProperty('--d', Math.min(i, REVEAL.maxSteps) * step + 'ms');
    });

    io.observe(group);
  }
}
