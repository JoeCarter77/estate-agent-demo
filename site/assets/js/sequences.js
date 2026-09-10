/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — SEQUENCES

   One loop, and it exists because the product genuinely does this:

     PROGRESS  an opportunity is read, given a priority, and resolved to
               exactly one next step. Different opportunities resolve to
               different steps — including, sometimes, no step at all. That
               is the argument of the chapter, so the chapter demonstrates it
               rather than asserting it.

   It is gated on visibility. Under prefers-reduced-motion it does not cycle,
   and the markup's default state is a complete, readable scenario.
   ═══════════════════════════════════════════════════════════════════════════ */

import { REDUCED, TIMING } from './config.js';
import { whileVisible } from './field.js';

function initAction(){
  const host = document.querySelector('[data-seq="act"]');
  if(!host) return;

  const chips    = Array.from(host.querySelectorAll('.ax'));
  const branches = Array.from(host.querySelectorAll('.ac__branch'));
  const choices  = (host.dataset.choices || '').split('|').map(s => s.trim()).filter(Boolean);

  const fields = Array.from(host.querySelectorAll('[data-cycle]'))
    .map(el => ({ el, options: el.dataset.cycle.split('|').map(s => s.trim()) }));

  const priority = host.querySelector('.ac__pri');

  if(!choices.length || !chips.length) return;

  /* The text is swapped at the midpoint of its own fade, so a scenario
     dissolves into the next one instead of jumping. */
  const swap = (el, next) => {
    if(el.textContent.trim() === next) return;
    el.classList.add('is-swap');
    setTimeout(() => {
      el.textContent = next;
      el.classList.remove('is-swap');
    }, 260);
  };

  const apply = (i) => {
    for(const { el, options } of fields) swap(el, options[i % options.length]);

    if(priority){
      const opts = priority.dataset.cycle.split('|').map(s => s.trim());
      host.dataset.tone = opts[i % opts.length].toLowerCase();
    }

    const key = choices[i % choices.length];
    chips.forEach(chip => chip.classList.toggle('is-on', chip.dataset.key === key));
    branches.forEach(branch => branch.classList.toggle('is-on', branch.dataset.key === key));
  };

  // Reduced motion gets the finished state of the first scenario, which is
  // the state the markup already describes.
  if(REDUCED){ apply(0); return; }

  let step = 0;
  whileVisible(host, () => { apply(step); step++; }, TIMING.act);
}

export function initSequences(){
  initAction();
}
