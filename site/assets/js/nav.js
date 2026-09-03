/* ═══════════════════════════════════════════════════════════════════════════
   NOVUS — NAVIGATION
   Three jobs, no scroll listeners:
     1. the header takes on a surface once the page has left the top
     2. the header links track the section being read
     3. the mobile overlay opens, closes and hands focus back

   There is exactly ONE scrollspy on the page. The product chapter's stages
   drive a panel, not a navigation, so nothing can disagree with the header
   about where the reader is.
   ═══════════════════════════════════════════════════════════════════════════ */

/* The header changes state when a 1px sentinel at the very top leaves view.
   Cheaper and smoother than measuring scrollY on every frame. */
function initStickyHeader(hdr){
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;';
  document.body.prepend(sentinel);

  if(!('IntersectionObserver' in window)) return;

  new IntersectionObserver(([entry]) => {
    hdr.classList.toggle('is-stuck', !entry.isIntersecting);
  }, { threshold: 0 }).observe(sentinel);
}

/* Marks whichever link points at the section currently occupying the middle
   of the viewport. */
function initScrollSpy(links){
  if(!('IntersectionObserver' in window)) return;

  const byId = new Map();
  for(const link of links){
    const id = (link.getAttribute('href') || '').replace('#', '');
    const target = id && document.getElementById(id);
    if(target) byId.set(target, link);
  }
  if(!byId.size) return;

  const visible = new Set();

  const io = new IntersectionObserver((entries) => {
    for(const entry of entries){
      if(entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    // The topmost visible section wins, so reading order decides the highlight.
    let winner = null;
    for(const section of byId.keys()){
      if(visible.has(section)){ winner = section; break; }
    }
    for(const [section, link] of byId){
      link.classList.toggle('is-active', section === winner);
    }
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

  byId.forEach((_, section) => io.observe(section));
}

function initMenu(){
  const burger = document.querySelector('.hdr__burger');
  const menu = document.getElementById('menu');
  if(!burger || !menu) return;

  // Stagger the overlay links so the menu composes rather than appears.
  menu.querySelectorAll('a').forEach((a, i) => {
    a.style.setProperty('--d', 60 + i * 45 + 'ms');
  });

  // Focus only returns to the button when the menu was actually open. Calling
  // focus() on the initial pass would leave a focus ring sitting on a page the
  // visitor has not touched.
  const setOpen = (open) => {
    const wasOpen = document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    burger.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-hidden', String(!open));
    if(!open && wasOpen) burger.focus({ preventScroll: true });
  };

  burger.addEventListener('click', () => {
    setOpen(!document.body.classList.contains('menu-open'));
  });

  menu.addEventListener('click', (e) => {
    if(e.target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && document.body.classList.contains('menu-open')) setOpen(false);
  });

  // A resize past the breakpoint should not leave the overlay stranded open.
  window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => {
    if(e.matches && document.body.classList.contains('menu-open')) setOpen(false);
  });

  setOpen(false);
}

export function initNav(){
  const hdr = document.querySelector('.hdr');
  if(hdr) initStickyHeader(hdr);

  initScrollSpy(document.querySelectorAll('.hdr__nav a'));
  initMenu();
}
