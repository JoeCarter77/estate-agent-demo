// scripts/novus-demo.mjs — INTERNAL DEBUGGING / RECOVERY TOOL.
//
// NOT PART OF THE ACQUISITION WORKFLOW. Demos are compiled automatically the
// moment PERSONALISATION completes (lib/demo-compile.mjs, run as the last step
// of lib/rebuild-pass.mjs). Nobody runs a build command per prospect. This CLI
// exists for the cases the automatic path cannot cover on its own:
//
//   • forcing a recompile of one row while debugging what a demo says
//   • the property-image backfill, which needs a real browser and therefore
//     cannot run inside a Serverless Function at all
//   • retiring or restoring a link
//
// WHY IT TALKS HTTP, NOT SHEETS. lib/sheets.mjs authenticates with a Vercel
// OIDC token federated through Workload Identity Federation — there is no
// service-account key, by GCP org policy, and no such token exists on a
// laptop. So this CLI drives the DEPLOYED /api/demo route with the same NOVUS
// Basic Auth credential a human uses, rather than trying to reach the
// workbook itself.
//
// THE DIVISION OF LABOUR ON IMAGES. The serverless build does one short fetch
// of the listing, which Rightmove often blocks. This CLI can do what a
// serverless function cannot: run a real Chromium, on a real residential-ish
// IP, and extract the hero photo from the rendered page — then hand the URL
// back to the build as `property_image_url`. That is the whole backfill
// mechanism; `backfill-images` is just this loop over several probes.
//
// Usage
//   node scripts/novus-demo.mjs image <listing-url> [--browser]
//   node scripts/novus-demo.mjs build <probe_id> [--slug s]
//                                     [--browser] [--image <url>] [--refresh-image]
//   node scripts/novus-demo.mjs backfill-images <probe_id> [probe_id ...]
//   node scripts/novus-demo.mjs archive <probe_id> | restore <probe_id>
//   node scripts/novus-demo.mjs audit [--fix]
//
// Env (or flags):
//   NOVUS_DEMO_BASE_URL   https://your-deployment            (--base)
//   NOVUS_BASIC_AUTH_USER / NOVUS_BASIC_AUTH_PASS            (--user / --pass)

import { fetchPropertyImageUrl, fetchPropertyImageUrlViaBrowser } from '../lib/property-image.mjs';

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args.flags[key] = true; continue; }
    args.flags[key] = next;
    i += 1;
  }
  return args;
}

function config(flags) {
  const base = String(flags.base || process.env.NOVUS_DEMO_BASE_URL || '').replace(/\/+$/, '');
  const user = String(flags.user || process.env.NOVUS_BASIC_AUTH_USER || '');
  const pass = String(flags.pass || process.env.NOVUS_BASIC_AUTH_PASS || '');
  if (!base) die('Set --base or NOVUS_DEMO_BASE_URL to the deployment URL (e.g. https://novus.vercel.app)');
  if (!user || !pass) die('Set --user/--pass or NOVUS_BASIC_AUTH_USER/NOVUS_BASIC_AUTH_PASS');
  return { base, auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function post(cfg, body) {
  const res = await fetch(`${cfg.base}/api/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: cfg.auth },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status} ${data.error || 'request failed'}`);
  return data;
}

// Extract once, cheaply, then escalate to a real browser only if asked.
async function extractImage(listingUrl, useBrowser) {
  if (!listingUrl) return '';
  process.stdout.write('  fetching listing…');
  let image = await fetchPropertyImageUrl(listingUrl);
  if (image) { console.log(` found\n  ${image}`); return image; }
  if (!useBrowser) { console.log(' blocked (pass --browser to retry with a real browser)'); return ''; }
  console.log(' blocked');
  process.stdout.write('  retrying with a real browser…');
  image = await fetchPropertyImageUrlViaBrowser(listingUrl);
  console.log(image ? ` found\n  ${image}` : ' nothing (leaving the image blank)');
  return image;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdImage(args) {
  const url = args._[1];
  if (!url) die('Usage: novus-demo.mjs image <listing-url> [--browser]');
  const image = await extractImage(url, args.flags.browser === true);
  if (!image) process.exit(2);            // non-zero so a script can branch on it
}

async function cmdBuild(args) {
  const probeId = args._[1];
  if (!probeId) die('Usage: novus-demo.mjs build <probe_id> [--browser]');
  const cfg = config(args.flags);

  const body = { action: 'build', probe_id: probeId, compiled_by: 'cli' };
  if (typeof args.flags.slug === 'string') body.slug = args.flags.slug;
  if (typeof args.flags.image === 'string') body.property_image_url = args.flags.image;
  if (args.flags['refresh-image'] === true) body.refresh_image = true;

  console.log(`\nBuilding demo for ${probeId}…`);
  let result = await post(cfg, body);
  report(cfg, result);

  // Second pass: the server's cheap fetch came back blank and we CAN do
  // better locally. This is the same code path backfill-images uses.
  if (!result.property_image_url && args.flags.browser === true && result.property_url) {
    console.log('\nNo image from the serverless fetch — escalating locally.');
    const image = await extractImage(result.property_url, true);
    if (image) {
      result = await post(cfg, { ...body, property_image_url: image });
      console.log('\nRebuilt with the extracted image:');
      report(cfg, result);
    }
  }
  return result;
}

async function cmdBackfillImages(args) {
  const probeIds = args._.slice(1);
  if (probeIds.length === 0) die('Usage: novus-demo.mjs backfill-images <probe_id> [probe_id ...]');
  const cfg = config(args.flags);

  let filled = 0;
  for (const probeId of probeIds) {
    console.log(`\n── ${probeId}`);
    // A build with no image flags keeps any image the row already has, so a
    // backfill never overwrites a good image with a blocked fetch.
    let result;
    try {
      result = await post(cfg, { action: 'build', probe_id: probeId, compiled_by: 'cli' });
    } catch {
      continue; // post() already reported and exited on hard failures
    }
    if (result.property_image_url) { console.log('  already has an image — skipped'); continue; }
    if (!result.property_url) { console.log('  no property_url on the probe — skipped'); continue; }
    const image = await extractImage(result.property_url, true);
    if (!image) { console.log('  could not extract — left blank (the demo still renders)'); continue; }
    await post(cfg, { action: 'build', probe_id: probeId, compiled_by: 'cli', property_image_url: image });
    filled += 1;
    console.log('  ✓ stored');
  }
  console.log(`\nBackfilled ${filled} of ${probeIds.length} probe(s).\n`);
}

async function cmdArchive(args, archive) {
  const probeId = args._[1];
  if (!probeId) die(`Usage: novus-demo.mjs ${archive ? 'archive' : 'restore'} <probe_id>`);
  const cfg = config(args.flags);
  const result = await post(cfg, { action: archive ? 'archive' : 'restore', probe_id: probeId });
  console.log(`\n${result.demo_slug} → ${result.demo_status}`);
  console.log(`${cfg.base}/demo/${result.demo_slug}\n`);
}


// ── audit ────────────────────────────────────────────────────────────────────
//
// EVERY demo link, checked the way a prospect checks it. The server-side
// `audit` action puts each slug through the same resolver the public GET uses;
// this then OPENS each one over HTTP as an anonymous request, so what is
// reported is the real answer including the deployment, the rewrite and the
// route — not just what the workbook believes.
//
// --fix recompiles the broken ones through the pipeline's own compiler and
// re-reports. It never rewrites a URL: a link that cannot be made to resolve
// is listed, with the reason, so it can stop being treated as campaign-ready.
async function cmdAudit(args) {
  const cfg = config(args.flags);
  const fix = args.flags.fix === true;

  console.log(`\nAuditing every demo slug against ${cfg.base}${fix ? ' (with --fix)' : ''}…`);
  const result = await post(cfg, { action: 'audit', fix });

  // The second, independent check: a real anonymous request per slug. The
  // workbook can say `ready` and the link can still be dead.
  const live = [];
  for (const demo of result.demos) {
    const url = `${cfg.base}/api/demo?slug=${encodeURIComponent(demo.demo_slug)}`;
    let status = 0;
    let error = '';
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      status = res.status;
      if (!res.ok) error = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
    } catch (err) {
      error = err?.message || String(err);
    }
    live.push({ ...demo, http_status: status, http_error: error, live_ok: status === 200 });
  }

  const working = live.filter((d) => d.live_ok);
  const broken = live.filter((d) => !d.live_ok);

  console.log(`\n  total tested   ${live.length}`);
  console.log(`  working        ${working.length}`);
  console.log(`  broken         ${broken.length}`);
  if (result.missing_demo_rows.length > 0) {
    console.log(`  no demo row    ${result.missing_demo_rows.length} personalised probe(s) with no DEMOS row: ${result.missing_demo_rows.join(', ')}`);
  }
  if (result.fixed) {
    console.log(`\n  recompiled     ${result.fixed.recompiled}`);
    console.log(`  repaired       ${result.fixed.repaired}`);
    console.log(`  still broken   ${result.fixed.still_broken}`);
    for (const problem of result.fixed.problems || []) {
      console.log(`  ⚠  ${problem.probe_id}: ${problem.error}`);
    }
  }

  if (broken.length > 0) {
    console.log('\nBroken links — NOT campaign-ready:');
    for (const demo of broken) {
      console.log(`\n  ${cfg.base}/demo/${demo.demo_slug}`);
      console.log(`    probe    ${demo.probe_id || '(none)'} · ${demo.agency_name || '(no agency)'}`);
      console.log(`    status   ${demo.demo_status || '(blank)'} -> resolves as ${demo.effective_status}`);
      console.log(`    http     ${demo.http_status} ${demo.http_error}`);
      if (demo.reason) console.log(`    why      ${demo.reason}`);
    }
  }
  console.log('');
  return { working: working.length, broken: broken.length, tested: live.length };
}

function report(cfg, result) {
  console.log(`  slug     ${result.demo_slug}`);
  console.log(`  status   ${result.demo_status}`);
  console.log(`  journey  ${result.hero_journey}`);
  console.log(`  image    ${result.property_image_url || '(none — the drawn placeholder is used)'} [${result.property_image_status}]`);
  console.log(`  url      ${cfg.base}/demo/${result.demo_slug}`);
  for (const reason of result.review_reasons || []) console.log(`  ⚠  ${reason}`);
}

const COMMANDS = {
  image: cmdImage,
  audit: cmdAudit,
  build: cmdBuild,
  'backfill-images': cmdBackfillImages,
  archive: (args) => cmdArchive(args, true),
  restore: (args) => cmdArchive(args, false),
};

const args = parseArgs(process.argv.slice(2));
const command = COMMANDS[args._[0]];
if (!command) {
  console.log(`
NOVUS personalised demos — internal debugging / recovery tool.
Demos compile automatically when PERSONALISATION completes; none of this is
needed in the normal acquisition workflow.

  image <listing-url> [--browser]            extract a hero photo and print it
  build <probe_id> [--browser]               force a recompile of one DEMOS row
  backfill-images <probe_id> [probe_id ...]  fill in missing property images
  archive <probe_id> / restore <probe_id>    retire or restore a demo link
  audit [--fix]                              check every demo slug resolves

  --base   deployment URL      (or NOVUS_DEMO_BASE_URL)
  --user   / --pass            (or NOVUS_BASIC_AUTH_USER / NOVUS_BASIC_AUTH_PASS)
  --slug   override the generated slug
  --image  supply a property image URL by hand
  --refresh-image  re-resolve an image the row already has
  --fix    audit only: recompile every demo that does not resolve
`);
  process.exit(args._[0] ? 1 : 0);
}
command(args).catch((err) => die(err?.message || String(err)));
