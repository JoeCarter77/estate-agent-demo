# Personalised demo rebuild — 7 September 2026

Implemented against the supplied NOVUS Offer Sheet v1.0 and the detailed rebuild brief. The brief determines the demo's section order and exact requested copy. Pilot terms and pricing from the offer sheet intentionally do not appear.

## Changed files

- `demo.html`: new six-part narrative, factual enquiry record, neutral transition, commercial question, connected methodology and qualifying CTA.
- `site/assets/css/demo.css`: demo-specific composition and responsive styles using the existing NOVUS tokens and fonts.
- `site/assets/js/demo.js`: factual renderer, URL resolution, scroll reveals, enquiry pullback, lazy calendar and telemetry.
- `lib/demo-facts.mjs`: explicit public factual payload and raw-source adapter.
- `api/demo.js`: opt-in `facts=1` response for the new renderer. Existing API clients keep their old payload.
- `scripts/novus-demo-facts-selftest.mjs`: factual and API contract regression checks.
- `scripts/novus-demo-browser-test.mjs`: desktop/mobile browser checks.
- `scripts/novus-demo-preview.mjs`: isolated local preview with synthetic cases and optional captured live snapshot.
- This handover document.

## Architecture and retained infrastructure

`/{slug}`, `/demo/{slug}` and `/demo.html?slug=...` still resolve the same stored DEMOS row. The new browser requests `/api/demo?slug=...&facts=1`. After the existing availability checks, two parallel source reads retrieve PROBES and COMMUNICATIONS. Only an allowlist of listing/enquiry facts and event timestamps reaches this renderer. No diagnosis generation, Rightmove scraping, database migration or recompilation runs when this payload is built.

The existing listing image resolver, stored photo URLs, logo, Fraunces/Inter typography, shared colour tokens, slug handling, archive policy and production view/click/booking telemetry remain. Scroll reveals and the pullback concept remain, with a smaller event-driven animation implementation. The old continuously animated canvas is removed. There is no scroll lock. Mobile uses fewer contact fragments and a shorter scroll sequence. Reduced motion and short viewports show the question statically.

The existing Calendly destination is retained. Its URL ends in `/10min`, but its actual embedded event displays **20 min**, verified in Chrome. The iframe is created on the first booking click. A new-tab link remains available. Booking messages must originate from Calendly and from that iframe. Preview mode suppresses click/booking telemetry, consistent with the existing suppression of preview views.

The Vercel configuration, operator UI, acquisition systems, pipeline compiler and shared homepage styles were not changed. No new dependency was added. The combined demo HTML/CSS/JS is approximately 35 KB uncompressed, versus approximately 61 KB for the previous demo HTML alone.

## Removed from the experience

Grades, Needs review, generated handling summaries, unresolved questions, commercial implications inferred from one probe, agency-wide failure claims, action recommendations for the probe and personalised accusations. The commercial story after the enquiry is standardised. Contact types in the wider field are explicitly illustrative, without counts or claimed agency findings.

## Old dependencies that remain

The legacy `lib/demos.mjs`, `lib/demo-journeys.mjs` and compiler still produce diagnostic/journey fields for existing consumers. Readiness checks still depend on legacy completeness rules, including `commercial_consequence`, selected journey content and, where required, `positive_observation`. Unsupported journeys and missing PERSONALISATION can still prevent compilation. Those existing pipeline gates were intentionally not rewritten as part of this renderer task. `needs_review` still requires preview mode and archived demos remain unavailable; neither status is displayed as a report card.

## Factual assumptions and edge cases

- Exact message text is preserved when stored. Historical/portal records containing the explicit declaration marker are labelled **Recorded enquiry content**, not presented as a verbatim quotation. HOME Partnership's real source is such a record.
- Explicit seller declarations enable the short seller passage. A conservative literal first-person declaration also works; uncertain statements are omitted. No seller conclusion is derived from diagnosis.
- Only incoming communications matched to the same probe (and agency when supplied) appear. Deleted, ambiguous, unrelated and outgoing records are excluded. Duplicate communication IDs are collapsed.
- Timestamps must have an explicit timezone. Invalid or ambiguous timestamps are omitted; valid `received_at` can substitute for missing/invalid `occurred_at`. Display uses Europe/London, including BST. No elapsed-time judgement appears.
- Four events appear initially; additional reliable events remain under a disclosure. Missing communications produce a shorter record, without suggesting that the team failed to respond.
- Missing source tabs fall back to the existing snapshot. Missing text has a small explanatory line. Missing/broken images show an honest image-unavailable state, retaining the address and available listing link. No stock replacement is used.
- Property type/bedrooms are displayed only when present in the source. No extra listing scrape is attempted.
- Two extra parallel source reads are the tradeoff for giving already-created demos factual content without schema changes. They read existing workbook tables and may add latency on a cold request.

## Validation

- Existing `npm run novus:demo-selftest`: **154 checks passed**.
- New factual and API checks passed: exact text, historical records, seller/no-seller cases, safe URLs, event filtering, source failures, strong handling, legacy payload compatibility and archive/readiness gates.
- Chrome browser checks passed at **1440×1000, 390×844 and 320×740**: real image loading, title/address, horizontal overflow, zoom/question reveal, methodology, CTA and no JavaScript runtime errors.
- Sparse and strong-handling fixtures passed, including extra-event disclosure and reduced-motion treatment.
- Invalid route shows a recoverable error state.
- Embedded Calendly loaded and displayed **20 min**. No meeting was booked.
- Screenshots were visually reviewed. One contact label was repositioned to keep it away from the main question.
- Real route testing uses a read-only capture of the existing `home-27` demo and its matched `prb_hist_0022` PROBES record. Its real property image loaded from the existing Rightmove media URL. No additional communication events were invented for that capture; multi-event behaviour was tested separately with synthetic fixtures.

## Preview URLs and deployment status

This rebuild is implemented locally; it has **not been deployed** to the production domain.

While the local preview server is running:

- `http://127.0.0.1:4311/home-27?preview=1` — real HOME Partnership demo snapshot.
- `http://127.0.0.1:4311/demo/home-27?preview=1` — preserved alternate route.
- `http://127.0.0.1:4311/preview-sparse?preview=1` — synthetic sparse record.
- `http://127.0.0.1:4311/preview-strong?preview=1` — synthetic well-handled enquiry.

Start synthetic previews with `node scripts/novus-demo-preview.mjs`. The current real snapshot preview was started with `node scripts/novus-demo-preview.mjs --snapshot /tmp/novus-real-demo.json`. The captured live data stays outside the repository; `/tmp` files are temporary. The preview never forwards telemetry or writes to production.

After deploying through the existing Vercel workflow, the existing production URL `https://demo.getnovus.co.uk/home-27?preview=1` will show the rebuild. It currently remains on the prior deployed version.
