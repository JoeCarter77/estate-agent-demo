/* Native disclosures remain usable without JS. Animate measured height so
   answers of any length can open and close without a guessed max-height. */
export function initFaq(){
  const items = [...document.querySelectorAll('.faq__item')];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const states = new Map(items.map(item => [item, {expanded:item.open, animation:null}]));

  function setOpen(item, expanded){
    const state = states.get(item);
    const from = item.getBoundingClientRect().height;
    state.animation?.cancel();
    state.animation = null;
    state.expanded = expanded;
    if(motion.matches || !item.animate){ item.open = expanded; return; }

    item.open = true;
    const to = expanded ? item.getBoundingClientRect().height
      : item.querySelector('summary').getBoundingClientRect().height + 1;
    const animation = item.animate([{height:`${from}px`}, {height:`${to}px`}], {
      duration:220, easing:'cubic-bezier(.22,.61,.36,1)'
    });
    state.animation = animation;
    animation.onfinish = () => {
      item.open = state.expanded;
      state.animation = null;
    };
  }

  for(const item of items){
    item.querySelector('summary').addEventListener('click', event => {
      event.preventDefault();
      const expanded = !states.get(item).expanded;
      if(expanded) for(const other of items){
        if(other !== item && states.get(other).expanded) setOpen(other, false);
      }
      setOpen(item, expanded);
    });
  }
  motion.addEventListener('change', event => {
    if(!event.matches) return;
    for(const [item, state] of states){
      state.animation?.cancel();
      state.animation = null;
      item.open = state.expanded;
    }
  });
}
