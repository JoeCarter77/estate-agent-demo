// lib/probe-identity.mjs — the per-probe reply address.
//
// WHY THIS EXISTS
// Matching an inbound agency reply back to the right probe was previously only
// possible via the SENDER: match the sender's email/domain to an agency, then
// find that agency's single active probe. Real probe traffic shows that path
// failing in three ways that no amount of care on the agency side can fix:
//
//   1. Agencies reply from individual mailboxes (terry@…, elliegrant@…), not
//      the generic address held in the agency record. Only the DOMAIN saves it.
//   2. Auto-acknowledgements are sent by CRM/relay platforms on the agency's
//      behalf — noreply@apex27.co.uk, noreply@send.agentresponse.co.uk,
//      autoresponder@rightmove.com. Those domains belong to no agency, so the
//      sender signal is structurally unmatchable.
//   3. If the same agency is ever probed twice, the sender alone cannot say
//      WHICH probe a reply belongs to.
//
// A per-probe plus-addressed reply address fixes all three at once. The probe
// is submitted on Rightmove with e.g. joe+rm0007@getnovus.co.uk; every reply,
// relayed or not, carries that address in To/Cc/Delivered-To. The probe tag is
// therefore evidence carried by the message itself, not an inference about who
// sent it — the probe (and through it the agency) is matched exactly, and the
// sender address becomes corroborating detail rather than the primary key.
//
// Gmail and Google Workspace both deliver plus-addressed mail to the base
// mailbox, so this needs no extra inbox and no provider configuration.

// "RM-0007" -> "rm0007". Kept alphanumeric-lowercase because some mail systems
// normalise case and choke on punctuation inside the plus tag.
export function probeTagFromReference(probeReference) {
  return String(probeReference ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// baseEmail "joe@getnovus.co.uk" + reference "RM-0007"
//   -> "joe+rm0007@getnovus.co.uk"
// Returns the unmodified base address when it is missing/malformed or the
// reference yields no tag — a probe must still be creatable if this is
// misconfigured, it just falls back to sender-based matching.
export function buildProbeEmail(baseEmail, probeReference) {
  const base = String(baseEmail ?? '').trim();
  const at = base.lastIndexOf('@');
  const tag = probeTagFromReference(probeReference);
  if (at <= 0 || !tag) return base;

  // Strip any plus tag already present on the configured base address so the
  // result is always exactly one tag deep.
  const local = base.slice(0, at).split('+')[0];
  const domain = base.slice(at + 1);
  return `${local}+${tag}@${domain}`;
}

// Pulls the probe tag back out of a delivery address.
// "joe+rm0007@getnovus.co.uk" -> "rm0007"; "joe@getnovus.co.uk" -> ''.
export function probeTagFromAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return '';
  const local = value.slice(0, at);
  const plus = local.indexOf('+');
  if (plus < 0) return '';
  return local.slice(plus + 1).replace(/[^a-z0-9]/g, '');
}

// An inbound email may carry the probe address in any of several headers
// depending on how the agency (or its CRM) replied — To, Cc, Delivered-To, or
// the original enquiry's Reply-To echoed back. Scans them all and returns the
// first probe tag found. Header values may be comma-separated lists and may be
// in "Name <addr>" form, both of which are handled.
export function extractProbeTag(...headerValues) {
  for (const value of headerValues) {
    if (!value) continue;
    const parts = String(value).split(',');
    for (const part of parts) {
      // Prefer an angle-bracketed address when present, else the bare token.
      const angle = part.match(/<([^>]+)>/);
      const candidate = angle ? angle[1] : part;
      const tag = probeTagFromAddress(candidate);
      if (tag) return tag;
    }
  }
  return '';
}
