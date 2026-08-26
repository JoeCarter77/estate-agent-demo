// scripts/novus-probe-rerun.mjs — re-personalise a named set of probes and
// print the persisted row, the demo status and the AI calls each one cost.
//
//   node scripts/novus-probe-rerun.mjs prb_hist_0002 prb_hist_0004 prb_hist_0005
//
// LIVE vs REPLAY. With ANTHROPIC_API_KEY set this makes real calls against the
// real prompt and prints real model output. Without one it cannot, and says so
// loudly rather than quietly printing something that looks live: it falls back
// to replaying each probe's recorded output as call 1 and answering any
// correction with a deterministic stand-in for a model following the prompt.
// The stand-in proves the plumbing — which fields survive, what each blank
// means, how many calls it costs — never the prose.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __setAiCallerForTests } from '../lib/ai-client.mjs';
import { personaliseProbe, buildOpportunityShape } from '../lib/probe-personalisation.mjs';
import { buildDemoRow } from '../lib/demos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'historical-probes.json'), 'utf8'));
const wanted = process.argv.slice(2).filter((a) => a.startsWith('prb_'));
const targets = wanted.length ? fixtures.filter((f) => wanted.includes(f.probe_id)) : fixtures;
const LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
const text = (v) => String(v ?? '').trim();

function standIn(fixture) {
  const shape = buildOpportunityShape(fixture.probe, fixture.intelligence);
  const twoSided = /potential seller/.test(shape);
  const worked = Number((shape.match(/real next step: (\d+) of/) || [])[1] || 0);
  const attempts = Number((shape.match(/Contact attempts: (\d+)/) || [])[1] || 0);
  const hours = Number((shape.match(/First reply: ([\d.]+) hours/) || [])[1] || 0);
  const noReply = /no reply at all during/.test(shape);

  const observation = noReply
    ? "We didn't receive any response 4 days after the enquiry, and nobody picked up that I'd also mentioned I had a property to sell."
    : hours >= 16
      ? `It took nearly ${Math.round(hours)} hours to get back to the enquiry, and even then nobody picked up that I'd also said I had a property to sell.`
      : worked > 0
        ? "You handled the viewing side well, but nobody picked up that I'd also said I had a property to sell."
        : "You got back to the enquiry, but nobody picked up that I'd also said I had a property to sell.";

  // WHY IT MATTERS COMMERCIALLY. On a probe where a real person came back, an
  // outcome that needed my reply is off limits — I deliberately never sent one
  // — so those phrasings appear only in the no-reply branch, where they are
  // simply what happened.
  const hook = noReply
    ? (twoSided
      ? "That's 1 buyer enquiry and 1 potential seller, with neither ever becoming a conversation."
      : "That's 1 buyer enquiry that never reached a single person at your branch.")
    : !twoSided
        ? 'So a buyer already in front of you stayed a name in the inbox rather than someone you knew anything about.'
        : worked > 0
          ? 'So the buyer side moved forward, while the potential seller was missed entirely.'
          : 'That vendor was not a name on a cold list — they were already talking to you as a buyer.';

  // EMAIL 2 — the extra thing neither line above said.
  const hook2 = noReply
    ? 'The issue here was not qualification or follow-up quality — the enquiry never got a genuine human response at all.'
    : attempts > 1
      ? `${attempts} contact attempts shows real persistence; the gap is that every one of them worked the same side of the enquiry.`
      : worked > 0
        ? 'You handled the buying side well; the part worth a look is that the same message had already given you a second reason to call.'
        : 'The speed was fine — what got lost was the second reason that person was worth ringing back.';

  return { observation, hook, hook2, twoSided, worked };
}

function blankReason(field, fixture, row) {
  const { positive_finding_index: pos, main_finding_index: main } = fixture.selection;
  const noContact = text(fixture.intelligence.human_contact) === 'none';
  if (text(row[field])) return '';
  if (field === 'fair_observation') {
    return pos === null
      ? (noContact ? 'no reply at all, so there is nothing to credit' : 'this probe has no genuine [POSITIVE] finding')
      : 'UNEXPLAINED';
  }
  if (field === 'main_finding') {
    if (noContact) return 'the complete_miss demo tells the no-response story itself';
    return main === null ? 'no problem/opportunity finding exists' : 'UNEXPLAINED';
  }
  if (field === 'commercial_consequence') return main === null ? 'no problem/opportunity finding exists' : 'UNEXPLAINED';
  return 'UNEXPLAINED';
}

const FIELDS = ['email_observation', 'email_commercial_hook', 'email_commercial_hook_email_2',
  'fair_observation', 'main_finding', 'commercial_consequence'];

async function main() {
  console.log(LIVE
    ? '── LIVE RUN — real model calls against the current prompt\n'
    : '── REPLAY (no ANTHROPIC_API_KEY in this environment)\n'
      + '   Call 1 replays each probe\'s recorded output; a correction is answered by a\n'
      + '   deterministic stand-in for a model following the new prompt. The field/blank/\n'
      + '   call/demo columns are real. The prose is NOT live model output.\n');

  for (const fixture of targets) {
    let calls = 0;
    const repaired = [];
    if (!LIVE) {
      const sim = standIn(fixture);
      __setAiCallerForTests(async ({ tool }) => {
        calls += 1;
        if (tool.name === 'record_probe_personalisation') {
          return {
            ...fixture.recorded_model_output,
            email_observation: sim.observation,
            email_commercial_hook: sim.hook,
            email_commercial_hook_email_2: sim.hook2,
          };
        }
        repaired.push(...tool.input_schema.required);
        return Object.fromEntries(tool.input_schema.required.map((f) => [f,
          f === 'email_commercial_hook' ? sim.hook
            : f === 'email_commercial_hook_email_2' ? sim.hook2
              : f === 'email_observation' ? sim.observation
              : f === 'commercial_consequence'
                ? (sim.twoSided ? 'the potential seller in that same enquiry was never taken to a valuation conversation.'
                  : 'the buyer enquiry itself never reached a next step.')
                : f === 'fair_observation' ? 'you picked the enquiry up and came back with the right property details.'
                  : 'the enquiry never reached the next step it needed.']));
      });
    }

    const row = await personaliseProbe(fixture.probe, fixture.intelligence, fixture.diagnosis,
      fixture.findings, { agency_name: fixture.agency_name });
    const compiled = buildDemoRow({
      probe: fixture.probe, agency: { agency_name: fixture.agency_name },
      intelligence: fixture.intelligence, findings: fixture.findings,
      personalisation: { personalisation_id: `psn_${fixture.probe_id}`, ...row },
      communications: [], now: new Date().toISOString(),
    });

    const sel = fixture.selection;
    console.log(`━━ ${fixture.probe_id}  ${fixture.agency_name}`);
    console.log(`   selection  positive=${sel.positive_finding_index ?? '—'} main=${sel.main_finding_index ?? '—'} wider=${sel.wider_finding_index ?? '—'}   hero=${row.hero_journey}`);
    for (const field of FIELDS) {
      const value = text(row[field]);
      const reason = blankReason(field, fixture, row);
      console.log(`   ${field.padEnd(31)}${value || `(blank — ${reason})`}`);
    }
    console.log(`   demo status            ${compiled.status}${compiled.reasons.length ? `  [${compiled.reasons.join(' · ')}]` : ''}`);
    console.log(`   AI calls used          ${row.ai_calls_used ?? calls}${repaired.length ? `  (scoped repair: ${[...new Set(repaired)].join(', ')})` : ''}`);
    console.log('');
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
