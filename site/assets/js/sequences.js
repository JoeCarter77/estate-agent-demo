/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — SEQUENCES

   One small loop, and it exists because the product genuinely does this:

     OPTIMISE  understand → act → outcome → learn is a cycle, so one stage is
               lit at a time and the ring never stops.

   It is gated on visibility. Under prefers-reduced-motion it does not run,
   and the markup's default state is the readable one.
   ═══════════════════════════════════════════════════════════════════════════ */

import { REDUCED, TIMING } from './config.js';
import { whileVisible } from './field.js';

/* Moves a single class along a list of nodes, one step per interval. */
function cycleClass(host, nodes, className, interval){
  if(!host || !nodes.length) return;
  let i = 0;
  whileVisible(host, () => {
    nodes.forEach((node, n) => node.classList.toggle(className, n === i % nodes.length));
    i++;
  }, interval);
}

function initLoop(){
  const host = document.querySelector('[data-seq="loop"]');
  if(!host) return;
  const nodes = Array.from(host.querySelectorAll('.l-node'));

  if(REDUCED){
    if(nodes[0]) nodes[0].classList.add('l-node--on');
    return;
  }

  cycleClass(host, nodes, 'l-node--on', TIMING.loop);
}

export function initSequences(){
  initLoop();
}
