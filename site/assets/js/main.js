/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — ENTRY
   Five small modules, no dependencies, no framework. Everything below is
   progressive: the page is complete before any of it runs.
   ═══════════════════════════════════════════════════════════════════════════ */

import { initReveal } from './reveal.js';
import { initNav } from './nav.js';
import { initField } from './field.js';
import { initStages } from './stages.js';
import { initSequences } from './sequences.js';

function boot(){
  initNav();
  initReveal();
  initField();
  initStages();
  initSequences();
  document.documentElement.classList.add('js-ready');
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot, { once: true });
}else{
  boot();
}
