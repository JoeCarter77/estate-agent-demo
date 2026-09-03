/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — SEQUENCES

   Two small loops that exist because the product genuinely does these things:

     ACT       the channel is selected per opportunity, so the channel row
               shows a selection being made rather than six options sitting
               there inertly.

     OPTIMISE  identify → act → outcome → learn is a cycle, so one stage is
               lit at a time and the ring never stops.

   Both are gated on visibility. Under prefers-reduced-motion neither runs,
   and the markup's default state is the readable one.
   ═══════════════════════════════════════════════════════════════════════════ */

import { REDUCED, TIMING } from './config.js';
import { whileVisible } from './field.js';

/* Moves a single class along a list of nodes, one step per interval. */
function cycleClass(host, nodes, className, interval, onStep){
  if(!host || !nodes.length) return;
  let i = 0;
  whileVisible(host, () => {
    nodes.forEach((node, n) => node.classList.toggle(className, n === i % nodes.length));
    if(onStep) onStep(nodes[i % nodes.length], i);
    i++;
  }, interval);
}

function initChannels(){
  const host = document.querySelector('[data-seq="channels"]');
  if(!host) return;
  const nodes = Array.from(host.querySelectorAll('.channels span'));

  if(REDUCED){
    // The finished state of this sequence is "a channel has been chosen".
    if(nodes[0]) nodes[0].classList.add('is-on');
    return;
  }

  // The label above the channel row names whatever is currently selected, so
  // the visitor reads a decision rather than a light show.
  const readout = host.querySelector('[data-seq-readout]');
  cycleClass(host, nodes, 'is-on', TIMING.channel, (node) => {
    if(readout && node) readout.textContent = node.textContent.trim();
  });
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
  initChannels();
  initLoop();
}
