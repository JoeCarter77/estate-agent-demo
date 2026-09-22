# Probe-led five-minute-call campaign audit

## Already working

- Campaigns have draft creation, audience snapshots, live eligibility rechecks, Instantly draft push, explicit launch, pause, sync and event history. No existing campaign rows need removal.
- Instantly replies have durable ingestion, agency/contact/campaign-member matching, duplicate email claims, deterministic opt-out handling and an action reconciliation path.
- Calling Mode already has call actions, due-time ordering, UK number normalisation, London callback scheduling, call outcomes and meeting transitions. Email opt-out is separate from telephone suppression.
- Campaign send counts come from Instantly analytics and the event ledger. Calling and discovery outcomes are recorded separately.

## Changes for this campaign

- Added an immutable four-step campaign preset with day gaps of 2, 4 and 5, empty follow-up subjects to keep the thread, and explicit cohort selection.
- Added campaign-specific eligibility for a submitted closed probe, usable property, recorded seller declaration, valid email and no active conversation, meeting, opt-out or active campaign.
- Before push, provider draft copy and existing members are checked. Existing leads are adopted; active leads in another NOVUS campaign are blocked.
- Probe-call replies are deterministically classified on the live poll even while semantic classification of older campaigns remains disabled. Explicit call replies create critical actions with the raw reply, matched probe, campaign and callback time. A number found only in a signature, quote or address is excluded. A missing number stays open for review.
- Calling Mode displays the campaign-specific opening and discovery-meeting script for these respondents and shows the original reply and probe context.
- The campaign detail view reports actual sends from the event ledger or Instantly analytics, available delivered count, interested and number replies, critical call actions, attempts, owners reached, meetings, and pilots agreed.

## Operational limits

- Instantly's `stop_on_reply` is the primary follow-up stop. A reply from an alias that Instantly does not associate with the enrolled lead may still need operator review in Instantly.
- Delivered count is blank when Instantly supplies no delivered metric. It is never inferred from sends.
- NOVUS records pilot agreement but has no verified pilot-sale status. Pilots sold is shown as unavailable rather than treating agreement as a sale.
- Provider draft configuration and account availability have only been checked with deterministic fakes. A real draft push and one-recipient preview are the next controlled checks; neither has been run.
- Calling Mode displays the campaign script over the lead's assigned general script; the call record still carries that existing script ID. Campaign attribution is carried by the originating action and reply.
