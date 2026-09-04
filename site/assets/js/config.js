/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — SITE CONFIG
   Everything tunable about the page's behaviour lives here.

   PRICING
   Public prices are controlled by one attribute on <body> in index.html:

       <body data-pricing="on">    prices visible
       <body data-pricing="off">   prices hidden, "Pricing on request" shown

   It is an attribute rather than a JS flag on purpose: switching it must not
   depend on a script running, and must never flash the wrong state.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Motion. Read once — a visitor who has asked their OS for less movement gets
   the finished composition, never a broken one. */
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Timings, in milliseconds. */
export const TIMING = {
  ledger: 2600,   // how long each opportunity in the hero ledger stays lit
  loop: 2000,     // how long each stage of the optimise loop stays lit
  pip: 3400,      // one signal's journey into the intelligence layer
};

/* Reveal geometry: an element is "in" once it is a little way up the viewport,
   so content is composed before the reader arrives at it. */
export const REVEAL = {
  rootMargin: '0px 0px -12% 0px',
  threshold: 0.08,
  stagger: 70,
  maxSteps: 10,   // stagger stops compounding after this many children
};
