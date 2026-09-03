/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — THE INTELLIGENCE FIELD (hero)

   Two things move here, and both of them mean something:

     1. PIPS   signals travelling from the agency into the intelligence layer,
               and resolved opportunities travelling back out. Drawn by the
               browser's own motion-path engine along the exact curves already
               in the SVG, so the animation and the drawing can never drift.

     2. LEDGER one opportunity is classified at a time: the label resolves,
               the connector lights and an action is selected. The action for
               a given classification alternates between cycles, because the
               system chooses the channel rather than being wired to one.

   Nothing runs while the hero is off-screen, and nothing runs at all under
   prefers-reduced-motion — where the ledger is simply shown fully resolved.
   ═══════════════════════════════════════════════════════════════════════════ */

import { REDUCED, TIMING } from './config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Motion paths are the one modern feature this page leans on. Where they are
   unsupported the field is still a complete, composed diagram — so the correct
   fallback is to draw no pips at all rather than to fake them in JS. */
const SUPPORTS_MOTION_PATH =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('offset-path', 'path("M0 0 L1 1")');

function addPips(svg){
  const layer = svg.querySelector('.f-pips');
  if(!layer) return;

  svg.querySelectorAll('.f-flow').forEach((path, i) => {
    const d = path.getAttribute('d');
    if(!d) return;

    const outbound = path.classList.contains('f-flow--out');
    const pip = document.createElementNS(SVG_NS, 'circle');
    pip.setAttribute('r', outbound ? '2' : '2.2');
    pip.setAttribute('class', outbound ? 'pip pip--out' : 'pip');
    pip.style.offsetPath = `path("${d}")`;
    // Outbound pips leave on the offbeat, so the field never pulses in unison.
    pip.style.animation =
      `pipflow ${TIMING.pip}ms linear ${(outbound ? 900 : 0) + i * 340}ms infinite`;
    layer.appendChild(pip);
  });
}

/* Runs a callback on an interval, but only while `el` is on screen. */
function whileVisible(el, fn, interval){
  let timer = null;

  const start = () => { if(!timer){ fn(); timer = setInterval(fn, interval); } };
  const stop  = () => { if(timer){ clearInterval(timer); timer = null; } };

  if(!('IntersectionObserver' in window)){ start(); return; }

  new IntersectionObserver(([entry]) => {
    entry.isIntersecting ? start() : stop();
  }, { threshold: 0 }).observe(el);

  // A backgrounded tab should not keep a timer alive.
  document.addEventListener('visibilitychange', () => {
    if(document.hidden) stop();
  });
}

export function initField(){
  const field = document.querySelector('.field');
  if(!field) return;

  const svgs = Array.from(field.querySelectorAll('svg'));
  if(SUPPORTS_MOTION_PATH && !REDUCED) svgs.forEach(addPips);

  // Reduced motion: present the ledger already resolved. It is the finished
  // state of the animation, so nothing is lost — only the movement.
  if(REDUCED){
    field.querySelectorAll('.f-row').forEach(row => row.classList.add('is-live'));
    return;
  }

  // The desktop and mobile fields are the same diagram at two sizes; driving
  // both from one counter keeps them identical if the viewport changes.
  const rowSets = svgs.map(svg => Array.from(svg.querySelectorAll('.f-row')));
  const sigSets = svgs.map(svg => Array.from(svg.querySelectorAll('.f-sig')));
  if(!rowSets.some(set => set.length)) return;

  let step = 0;

  const tick = () => {
    for(const rows of rowSets){
      if(!rows.length) continue;
      const live = step % rows.length;
      const pass = Math.floor(step / rows.length);

      rows.forEach((row, i) => {
        const on = i === live;
        row.classList.toggle('is-live', on);
        if(!on) return;

        const action = row.querySelector('.f-act');
        if(!action) return;
        const options = (action.dataset.actions || action.textContent).split('|');
        action.textContent = options[pass % options.length].trim();
      });
    }

    // Two signals warm at a time, chosen so the pattern never looks like a
    // simple top-to-bottom sweep.
    for(const sigs of sigSets){
      if(!sigs.length) continue;
      const a = step % sigs.length;
      const b = (step * 3 + 2) % sigs.length;
      sigs.forEach((s, i) => s.classList.toggle('is-hot', i === a || i === b));
    }

    step++;
  };

  whileVisible(field, tick, TIMING.ledger);
}

export { whileVisible };
