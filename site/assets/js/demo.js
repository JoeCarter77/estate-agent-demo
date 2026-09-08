const $ = id => document.getElementById(id);
const text = value => String(value ?? '').trim();
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const preview = new URLSearchParams(location.search).get('preview') === '1';
let slug = '';
function resolveSlug() {
  const query = text(new URLSearchParams(location.search).get('slug'));
  if (query) return query;
  const parts = location.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[0] === 'demo' ? parts[1] || '' : parts[0] === 'demo.html' ? '' : parts[0] || '');
}
function set(id, value) { const node = $(id); node.textContent = text(value); node.hidden = !text(value); }
function safeURL(value) { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } }
function stamp(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',timeZone:'Europe/London'}).format(date) + ' · ' + new Intl.DateTimeFormat('en-GB', {hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/London'}).format(date);
}
function timeline(demo) {
  const events = Array.isArray(demo.communication_events) ? demo.communication_events : [];
  const allowed = new Set(['Enquiry sent', 'Email received', 'SMS received', 'Call recorded']);
  let count = 0;
  for (const event of events) {
    const when = stamp(event.at);
    if (!when || !allowed.has(event.label)) continue;
    const li = document.createElement('li');
    const time = document.createElement('time'); time.dateTime = event.at; time.textContent = when;
    const label = document.createElement('span'); label.textContent = event.label;
    li.append(time, label); (count < 4 ? $('timeline') : $('timeline-more')).append(li); count++;
  }
  if (!count) {
    const li = document.createElement('li');
    li.textContent = [text(demo.enquiry_date), text(demo.enquiry_time), 'Enquiry sent'].filter(Boolean).join(' · ');
    $('timeline').append(li);
  }
  $('more-events').hidden = count <= 4;
}
function render(demo) {
  slug = text(demo.demo_slug) || slug;
  const agency = text(demo.agency_name) || 'your agency';
  const street = text(demo.property_street || demo.property_address);
  document.title = 'NOVUS · ' + agency;
  set('header-agency', agency); set('footer-agency', 'Prepared for ' + agency);
  set('enquiry-eyebrow', 'A real enquiry to ' + agency);
  set('enquiry-title', street ? 'We sent this enquiry about ' + street.replace(/\.$/, '') + '.' : 'We sent this enquiry to your agency.');
  set('property-address', demo.property_address || street || 'The listing we enquired about');
  set('fact-buyer', street ? 'Interested in ' + street.replace(/\.$/, '') : 'Interested in this listing');
  set('property-price', text(demo.property_price).replace(/\.00\b/, ''));
  const portal = {rightmove:'Rightmove',zoopla:'Zoopla',onthemarket:'OnTheMarket'}[text(demo.portal).toLowerCase()];
  set('property-meta', [...(Array.isArray(demo.property_metadata) ? demo.property_metadata : []), portal ? 'Listed on ' + portal : ''].filter(Boolean).join(' · '));
  const listing = safeURL(demo.property_url); if (listing) { $('property-link').href = listing; $('property-link').hidden = false; }
  const src = safeURL(demo.property_image_url);
  if (src) {
    const photo = $('property-photo');
    photo.onload = () => { $('photo-unavailable').hidden = true; };
    photo.onerror = () => { photo.hidden = true; $('photo-unavailable').hidden = false; $('seed-photo').hidden = true; };
    photo.alt = 'Listing photograph: ' + (text(demo.property_address) || street);
    photo.src = src; photo.hidden = false;
    $('seed-photo').src = src; $('seed-photo').hidden = false;
  }
  set('probe-message', demo.probe_message);
  set('enquiry-record', demo.enquiry_record);
  set('message-label', demo.probe_message ? 'The enquiry we sent' : 'Recorded enquiry content');
  // Kept out of the main flow: a click reveals it, nothing more.
  const hasRecord = !!text(demo.probe_message || demo.enquiry_record);
  $('original-enquiry').hidden = !hasRecord;
  $('message-unavailable').hidden = hasRecord;
  const seller = demo.seller_declared === true || demo.seller_declared === 'yes';
  $('fact-seller').hidden = !seller;
  // The declaration and the contact address are two different facts. The
  // address is supporting metadata and is never presented as the property
  // being sold — see lib/demo-journeys.mjs for why that claim can't be made.
  const locality = text(demo.contact_locality);
  set('fact-locality', locality ? `Current address provided: ${locality} — not necessarily the property being sold.` : '');
  set('seed-street', street || 'The enquiry'); set('seed-agency', agency);
  timeline(demo);
  $('main').hidden = false; $('boot').hidden = true;
  document.querySelectorAll('[data-book]').forEach(node => { node.hidden = false; });
  startMotion();
}
function startMotion() {
  if ('IntersectionObserver' in window && !reduced.matches) {
    document.body.classList.add('motion-ready');
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
    }), {threshold:0,rootMargin:'0px 0px -40px 0px'});
    document.querySelectorAll('[data-reveal]').forEach(node => io.observe(node));
  }
  const zoom = $('zoom'), stage = zoom.querySelector('.zoom-stage');
  const mTrack = $('method-track'), mPin = mTrack.querySelector('.method-pin');
  const steps = [...$('steps').querySelectorAll('.step')];
  const panels = [...$('panels').querySelectorAll('.panel')];
  const ladder = $('ladder');
  // the travelling rail under the step labels, created here so the markup
  // stays a plain readable list
  const rail = document.createElement('i');
  rail.className = 'step-rail'; rail.setAttribute('aria-hidden', 'true');
  $('steps').append(rail);

  const clamp = n => Math.min(1, Math.max(0, n));
  const ease = (a,b,n) => { const t = clamp((n-a)/(b-a)); return t*t*(3-2*t); };
  // progress of a pinned track: 0 when the pin lands, 1 when it releases
  const pinned = (track, pin, header) => {
    const rect = track.getBoundingClientRect();
    const travel = rect.height - pin.offsetHeight;
    return travel > 0 ? clamp((header - rect.top)/travel) : 0;
  };
  const flowOf = (node, from = .88, to = .45) => {
    const rect = node.getBoundingClientRect();
    const travel = innerHeight*(from-to) + rect.height;
    return travel > 0 ? clamp((innerHeight*from - rect.top)/travel) : 1;
  };
  let active = -1;
  function setActive(i) {
    if (i === active) return;
    active = i;
    $('steps').style.setProperty('--active', i);
    steps.forEach((n, k) => n.classList.toggle('on', k === i));
    panels.forEach((n, k) => n.classList.toggle('on', k === i));
  }
  function releaseActive() {
    active = -1;
    $('steps').style.removeProperty('--active');
    steps.forEach(n => n.classList.remove('on'));
    panels.forEach(n => n.classList.remove('on'));
  }
  let queued = false;
  function update() {
    queued = false;
    const travel = document.documentElement.scrollHeight - innerHeight;
    $('progress').style.transform = `scaleX(${travel > 0 ? clamp(scrollY/travel) : 0})`;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head')) || 80;
    const staticMode = reduced.matches || innerHeight < 560;
    document.body.classList.toggle('static-zoom', staticMode);

    // The process only swaps panels on the wide pinned layout. Narrower than
    // that it is a plain vertical list with all four stages readable, so there
    // is nothing to drive and no scroll position to lose.
    if (staticMode || innerWidth <= 1050) { if (active !== -1) releaseActive(); }
    else {
      const mRect = mTrack.getBoundingClientRect();
      if (mRect.bottom > 0 && mRect.top < innerHeight) {
        setActive(Math.min(3, Math.floor(pinned(mTrack, mPin, header) * 4.2)));
      } else if (active === -1) setActive(0);
    }

    ladder.style.setProperty('--flow', staticMode ? '1' : flowOf(ladder).toFixed(3));
    if (staticMode) { stage.removeAttribute('style'); return; }

    const rect = zoom.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) return;
    const p = pinned(zoom, stage, header);
    // The card is already on screen at rest (arriving statically from the
    // transition above it) — it holds, then recedes as the pool and the
    // question take its place. No text lives in this pinned track any more.
    // The card shrinks and fades on the SAME curve, so it dissolves as it
    // recedes rather than shrinking solid and only then disappearing.
    const recede = ease(.14,.46,p);
    stage.style.setProperty('--seed', (1 - recede).toFixed(3));
    stage.style.setProperty('--seed-scale', (1 - .84*recede).toFixed(3));
    stage.style.setProperty('--field', ease(.30,.54,p).toFixed(3));
    stage.style.setProperty('--field-scale', (1.35 - .35*ease(.30,.64,p)).toFixed(3));
    // lands by .82 and HOLDS to the end of the track — it must not arrive as
    // the section is already leaving.
    stage.style.setProperty('--question', ease(.66,.82,p).toFixed(3));
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener('scroll', schedule, {passive:true}); addEventListener('resize', schedule, {passive:true});
  reduced.addEventListener('change', schedule); update();
}
function track(action) {
  if (!slug || preview) return;
  fetch('/api/demo', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,slug}),keepalive:true}).catch(() => {});
}
let calendarLoaded = false;
document.querySelectorAll('[data-book]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault(); $('booking').hidden = false;
  if (!calendarLoaded) {
    const url = new URL('https://calendly.com/joe-getnovus/10min');
    url.search = new URLSearchParams({embed_domain:location.hostname,embed_type:'Inline',hide_gdpr_banner:'1',background_color:'0a0b0e',text_color:'f1ede6',primary_color:'4e9bff'}).toString();
    $('calendar').src = url.href; calendarLoaded = true;
  }
  track('cta_click');
  $('booking').scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'start'});
}));
addEventListener('message', event => {
  if (event.origin !== 'https://calendly.com' || event.source !== $('calendar').contentWindow) return;
  if (event.data?.event === 'calendly.event_scheduled') track('meeting_booked');
});
function fail(message) { $('boot-line').hidden = true; set('boot-title', 'This demo link isn’t available.'); set('boot-message', message); $('retry').hidden = false; }
try {
  slug = resolveSlug();
  if (!slug) fail('Open the personalised link in your email to view your demo.');
  else {
    const response = await fetch('/api/demo?' + new URLSearchParams({slug,facts:'1',...(preview ? {preview:'1'} : {})}), {headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    const data = await response.json();
    if (!response.ok || !data.demo) fail('Please check the link, or contact the person who sent it.');
    else render(data.demo);
  }
} catch { fail('We couldn’t load your demo. Please try again in a moment.'); }
