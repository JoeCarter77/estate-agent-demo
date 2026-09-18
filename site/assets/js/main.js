/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — ENTRY
   Four small modules, no dependencies, no framework. Everything below is
   progressive: the page is complete before any of it runs.
   ═══════════════════════════════════════════════════════════════════════════ */

import { initReveal } from './reveal.js';
import { initNav } from './nav.js';
import { initField } from './field.js';
import { initFaq } from './faq.js';

function boot(){
  initNav();
  initReveal();
  initField();
  initFaq();
  document.documentElement.classList.add('js-ready');
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot, { once: true });
}else{
  boot();
}
