// The initial, measurable version of the probe-led acquisition campaign.
// Delays are relative to the preceding send: days 1, 3, 7 and 12.
export const PROBE_CALL_CAMPAIGN_NAME = 'NOVUS — Probe-Led 5-Minute Call';
export const PROBE_CALL_CAMPAIGN_TYPE = 'PROBE_FIVE_MINUTE_CALL';
export const PROBE_CALL_SCRIPT = `# Requested five-minute call

Hi {{first_name}}, it's Joe from NOVUS. Thanks for getting back to my email about the enquiry on {{property}}. Is now still a good time for five minutes?

I put that enquiry through and mentioned I had a property to sell. What caught my attention was how an ordinary buyer enquiry can also carry a possible seller opportunity. I wanted to understand how your team spots and follows up on those signals; I am not assuming anything went wrong.

The broader opportunity is in enquiries and database contacts you already have. Some people who look like buyers may also be considering a sale, and those signals can be easy to miss when teams are busy.

NOVUS helps agencies identify and act on those commercial opportunities in their existing enquiry and contact flow.

Would it be useful to book a proper discovery and demonstration meeting so I can show you the evidence and see whether it fits {{agency}}? If so, what time works for you?

Keep this introductory call brief. Confirm the next step and book the meeting when appropriate.`;

export const PROBE_CALL_SEQUENCE = Object.freeze({ steps: [
  { step: 1, delay_days: 0, variants: [{ subject: 'Quick one about {{property}}', body: 'Hi {{firstName}},\n\nI recently put an enquiry through on {{property}} and mentioned that I also had a property to sell.\n\nA couple of things caught my attention that I thought might be worth discussing with you.\n\nRather than explaining it all over email, is there a number I could catch you on for 5 minutes?\n\nJoe', disabled: false }] },
  { step: 2, delay_days: 2, variants: [{ subject: '', body: 'Hi {{firstName}},\n\nJust following up on this.\n\nWould be good to get your thoughts on something I noticed around the enquiry.\n\nIs there a good number to reach you on?\n\nJoe', disabled: false }] },
  { step: 3, delay_days: 4, variants: [{ subject: '', body: "Hi {{firstName}},\n\nJust to give you a bit more context — it's around how agencies recognise and act on potential commercial opportunities within the enquiries and database they already have.\n\nI think it could be quite relevant to {{agency}}.\n\nWould you have 5 minutes for a quick chat this week?\n\nJoe", disabled: false }] },
  { step: 4, delay_days: 5, variants: [{ subject: '', body: "Hi {{firstName}},\n\nLast one from me on this.\n\nHappy to explain what caught my attention if it's of interest — otherwise I'll leave you to it.\n\nWorth a quick call?\n\nJoe", disabled: false }] },
] });

export function isProbeCallSequence(sequence) {
  return JSON.stringify(sequence) === JSON.stringify(PROBE_CALL_SEQUENCE);
}

export function isMatchingInstantlyProbeCallCampaign(remote) {
  if (!remote || remote.name !== PROBE_CALL_CAMPAIGN_NAME || remote.stop_on_reply !== true || Number(remote.status) !== 0) return false;
  const steps = remote.sequences?.[0]?.steps || [];
  if (steps.length !== 4) return false;
  return steps.every((step, index) => {
    const expected = PROBE_CALL_SEQUENCE.steps[index];
    const variant = step.variants?.[0];
    const body = String(variant?.body || '').replace(/<br\s*\/?\s*>/gi, '\n').trim();
    return step.variants?.length === 1 && variant?.subject === expected.variants[0].subject
      && body === expected.variants[0].body && Number(step.delay) === (PROBE_CALL_SEQUENCE.steps[index + 1]?.delay_days || 0)
      && step.delay_unit === 'days';
  });
}
