/* Each diagram traces its direction once on entry. All information is visible
   before JavaScript runs; there are no timers, changing claims or scroll locks. */
export function initField(){
  const diagrams = document.querySelectorAll('[data-flow]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if(motion.matches || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    for(const entry of entries){
      if(!entry.isIntersecting) continue;
      entry.target.classList.add('is-connected');
      observer.unobserve(entry.target);
    }
  }, {threshold:.25});
  diagrams.forEach(diagram => observer.observe(diagram));
  motion.addEventListener('change', event => {
    if(!event.matches) return;
    observer.disconnect();
    diagrams.forEach(diagram => diagram.classList.remove('is-connected'));
  });
}
