// lib/probeCopy.mjs
// Formats a probe row into the single proof line shown at the top of the demo page.
// Pure functions, no I/O - safe to unit-test in isolation.

function formatLag(lagHrs) {
  const hrs = parseFloat(lagHrs);
  if (isNaN(hrs)) return '';
  if (hrs < 24) {
    const rounded = Math.round(hrs);
    return rounded === 1 ? '1 hour' : `${rounded} hours`;
  }
  const days = Math.round((hrs / 24) * 2) / 2; // nearest half day
  return days === 1 ? '1 day' : `${days} days`;
}

function daysSince(probeSent) {
  const sent = new Date(probeSent);
  if (isNaN(sent.getTime())) return '';
  const hrs = (Date.now() - sent.getTime()) / (1000 * 60 * 60);
  if (hrs < 24) return 'a few hours';
  const days = Math.round(hrs / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Returns the proof line for the top of the demo page, or null if there's no
 * usable probe data (in which case the block must not render at all).
 */
export function buildProbeLine(probe) {
  if (!probe || !probe.probeAddress || !probe.probeSent) return null;

  const listing = probe.probeAddress;
  const time = probe.probeSent;
  const tail =
    "What if that enquiry was a seller - and by the time you'd replied, they'd already booked their valuation with another agency?";

  if (probe.firstReply && probe.firstReply.trim() !== '') {
    const lag = formatLag(probe.lagHrs);
    if (!lag) return null;
    return `I enquired about ${listing} at ${time}. It took ${lag} for someone to get back to me. ${tail}`;
  }

  const since = daysSince(probe.probeSent);
  if (!since) return null;
  return `I enquired about ${listing} at ${time}. It's been ${since} and I still haven't got a reply. ${tail}`;
}
