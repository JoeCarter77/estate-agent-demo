/* Shared progressive-enhancement settings. */
/* Reveal geometry: an element is "in" once it is a little way up the viewport,
   so content is composed before the reader arrives at it. */
export const REVEAL = {
  rootMargin: '0px 0px -12% 0px',
  threshold: 0.08,
  stagger: 70,
  maxSteps: 10,   // stagger stops compounding after this many children
};
