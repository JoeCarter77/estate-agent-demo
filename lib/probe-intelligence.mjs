// lib/probe-intelligence.mjs — probe-level conclusions drawn with the WHOLE
// conversation and the original enquiry in view at once.
//
// This is the layer that answers the questions the pipeline could not previously
// even represent:
//   - Did the agency respond to the ACTUAL enquiry, or just send something?
//   - Was there a booking opportunity, and did the agency push toward it?
//   - Did the agency engage the declared vendor opportunity, or ignore it?
//   - What did the agency NOT do?
//
// "What the agency didn't do" is a first-class output here, not an absence.
// A missed opportunity is only ever asserted when the enquiry established that
// there WAS an opportunity (from lib/enquiry.mjs) and the communications show
// it was not taken (from lib/comm-assessment.mjs). Where the enquiry never
// created the opportunity, or the evidence cannot settle it, nothing is
// asserted — a blank stays blank.
//
// Nothing here grades. Grading remains lib/grading.mjs, unchanged.

import { parseEnquiry } from './enquiry.mjs';
import { assessCommunication } from './comm-assessment.mjs';

const RANK = { progressed: 3, discussed: 2, acknowledged: 1, no_evidence: 0 };

// Ordered most commercially important first. Each entry states the finding and
// the condition under which the evidence supports it.
function findMissedOpportunities({ enquiry, assessments, vendorStatus, responded }) {
  const misses = [];
  const humanAssessments = assessments.filter((a) => a.human);
  const genuine = assessments.filter((a) => a.genuine_response);

  // 1. A declared instruction opportunity that the agency never engaged.
  if (enquiry.has_property_to_sell && vendorStatus === 'no_evidence' && humanAssessments.length > 0) {
    const wasFlagged = assessments.some((a) => a.portal_flagged_valuation);
    misses.push({
      key: 'vendor_never_engaged',
      finding: wasFlagged
        ? 'The portal flagged the valuation opportunity in the subject line the agency replied on, and no reply ever mentioned selling, a valuation or an appraisal.'
        : 'The enquiry declared a property to sell that is not yet on the market, and no communication ever mentioned selling, a valuation or an appraisal.',
    });
  }

  // 1b. The opportunity was engaged but never converted into an appointment.
  if (enquiry.has_property_to_sell && (vendorStatus === 'acknowledged' || vendorStatus === 'discussed')) {
    misses.push({
      key: 'vendor_not_converted',
      finding: vendorStatus === 'acknowledged'
        ? 'The agency noted the enquirer had a property to sell but never offered a valuation or market appraisal off the back of it.'
        : 'Selling or a valuation was discussed but no valuation or market appraisal was ever actually booked.',
    });
  }

  // 2. The agency sent things, but never actually answered this enquiry.
  if (humanAssessments.length > 0 && genuine.length === 0) {
    misses.push({
      key: 'never_responded_to_enquiry',
      finding: 'Nothing the agency sent was a genuine reply to this enquiry — every human message was bulk/template content or carried no substance.',
    });
  }

  // 3. Responded, but never put an appointment on the table.
  if (genuine.length > 0 && !assessments.some((a) => a.offers_appointment)) {
    misses.push({
      key: 'no_appointment_offered',
      finding: 'The agency replied but never offered a viewing or valuation — the conversation never moved toward an appointment.',
    });
  }

  // 4. Raised an appointment but never proposed a time or asked availability.
  if (assessments.some((a) => a.offers_appointment) && !assessments.some((a) => a.pushes_specific_slot)) {
    misses.push({
      key: 'no_slot_pushed',
      finding: 'A viewing was raised but no specific time was ever proposed and the enquirer was never asked for their availability — the next step was left to the prospect.',
    });
  }

  // 5. The agency replied without ever naming the property enquired about.
  //    Deliberately narrow, because the absence of a mention is weak evidence:
  //      - only TEXT replies count. A voicemail that does not recite the street
  //        name is completely normal; an email that never names the property is
  //        a generic reply.
  //      - only when we recorded a usable, distinctive address in the first
  //        place (references_probe_property === null means unknowable, and
  //        stays silent rather than being read as "no").
  //    Without both guards this fired on four live probes purely because a
  //    voicemail did not say the postcode out loud.
  const textReplies = genuine.filter((a) => a.channel === 'email' || a.channel === 'sms');
  if (textReplies.length > 0 && textReplies.every((a) => a.references_probe_property === false)) {
    misses.push({
      key: 'property_never_named',
      finding: 'No written reply ever named the property that was enquired about.',
    });
  }

  // 6. The agency closed the lead itself.
  if (assessments.some((a) => a.disqualifies_lead)) {
    misses.push({
      key: 'lead_disqualified',
      finding: 'The agency assumed disinterest and closed the lead down itself rather than continuing to chase.',
    });
  }

  // 7. The agency pushed the work back onto the enquirer.
  if (assessments.some((a) => a.requires_self_service) && !responded) {
    misses.push({
      key: 'self_service_deflection',
      finding: 'The only engagement was a request that the enquirer go and register themselves, rather than the agency picking the enquiry up.',
    });
  }

  return misses;
}

// Vendor engagement, judged over the whole conversation rather than per phrase.
// Takes the phrase-level result lib/vendor-intent.mjs already produces and
// raises it when the wider context shows engagement that phrase list cannot
// see (the agency directly qualifying the enquirer's sell-side position).
function resolveVendorStatus({ enquiry, assessments, phraseStatus }) {
  if (!enquiry.has_property_to_sell) return '';
  let status = phraseStatus || 'no_evidence';
  if (assessments.some((a) => a.asks_vendor_position) && RANK[status] < RANK.acknowledged) {
    status = 'acknowledged';
  }
  return status;
}

// probe + its COMMUNICATIONS rows + the phrase-level vendor status
// -> the probe-level picture. Pure function, no I/O.
export function computeProbeIntelligenceContext({ probe, communications, phraseVendorStatus }) {
  const enquiry = parseEnquiry(probe);
  const assessments = communications
    .map((c) => ({ ...assessCommunication(c, enquiry), _at: new Date(c.occurred_at) }))
    .filter((a) => !Number.isNaN(a._at.getTime()))
    .sort((a, b) => a._at - b._at);

  const genuine = assessments.filter((a) => a.genuine_response);
  const responded = genuine.length > 0;
  const vendorStatus = resolveVendorStatus({ enquiry, assessments, phraseStatus: phraseVendorStatus });

  return {
    enquiry,
    assessments,
    genuine_responses: genuine,
    responded_to_enquiry: responded,
    vendor_status: vendorStatus,
    booking_opportunity_existed: true, // every probe in this system is a viewing enquiry
    booking_pushed: assessments.some((a) => a.pushes_specific_slot),
    appointment_offered: assessments.some((a) => a.offers_appointment),
    missed_opportunities: findMissedOpportunities({ enquiry, assessments, vendorStatus, responded }),
  };
}
