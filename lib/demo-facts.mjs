// Public demo facts. Deliberately independent of diagnosis, grading and generated copy.
import { hasVendorDeclaration } from './vendor-intent.mjs';
// The contact identity is a constant of the enquiry WE send, not agency data.
// demo-journeys.mjs owns the rule this renderer must not break: an address was
// supplied and it is in Billericay; that is ALL it establishes. It is never
// known to be the property the prospect intends to sell.
import { ENQUIRY_CONSTANTS } from './demo-journeys.mjs';
const text = value => String(value ?? '').trim();
const validDate = value => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text(value)) && Number.isFinite(Date.parse(value));
const explicitSale = message => message.split(/[.!?;]/).some(clause =>
  /\bI (?:also )?have (?:a |an |my )[^.!?;]{0,90}\bto sell\b/i.test(clause)
  && !/\b(?:not|nothing|never|don[’']t|do not)\b/i.test(clause));
const url = value => { try { const u = new URL(text(value)); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };

export function buildDemoFacts(row = {}, probe = {}, communications = []) {
  const id = text(row.probe_id);
  const enquiryAt = text(probe.probe_timestamp || row.enquiry_at);
  const record = text(probe.enquiry_text || row.enquiry_text);
  // Historical imports and the portal's declaration marker are operator records,
  // not necessarily the words sent by the prospect. Never invent a quotation.
  const isRecord = /declared:\s*has a property to sell|^Rightmove property enquiry\./i.test(record);
  const message = text(probe.probe_message || row.probe_message) || (isRecord ? '' : record);
  const events = validDate(enquiryAt) ? [{ at: enquiryAt, label: 'Enquiry sent' }] : [];
  const seen = new Set();
  const touches = communications.filter(comm => {
    if (text(comm.probe_id) !== id || text(comm.direction).toLowerCase() !== 'inbound') return false;
    if (text(comm.match_status).toLowerCase() !== 'matched') return false;
    if (text(comm.agency_id) && text(row.agency_id) && text(comm.agency_id) !== text(row.agency_id)) return false;
    return ['email', 'sms', 'phone', 'voice', 'call'].includes(text(comm.channel).toLowerCase());
  }).flatMap(comm => {
    const at = validDate(comm.occurred_at) ? comm.occurred_at : comm.received_at;
    if (!validDate(at) || (validDate(enquiryAt) && Date.parse(at) < Date.parse(enquiryAt))) return [];
    const channel = text(comm.channel).toLowerCase();
    const key = text(comm.communication_id) || `${channel}:${at}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ at, label: channel === 'email' ? 'Email received' : channel === 'sms' ? 'SMS received' : 'Call recorded' }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  events.push(...touches);
  const address = text(probe.property_address || row.property_address);
  return {
    demo_slug: text(row.demo_slug), agency_name: text(row.agency_name),
    property_address: address,
    property_street: text(probe.property_street || row.property_street) || address.replace(/^(\d+[a-z]?),\s*/i, '$1 ').split(',')[0],
    property_price: text(probe.property_price || row.property_price),
    property_image_url: url(row.property_image_url), property_url: url(probe.property_url || row.property_url),
    property_metadata: [text(probe.property_type || row.property_type), text(probe.bedrooms || row.bedrooms) ? `${text(probe.bedrooms || row.bedrooms)} bedrooms` : ''].filter(Boolean),
    portal: text(probe.portal || row.portal), enquiry_at: validDate(enquiryAt) ? enquiryAt : '',
    contact_locality: ENQUIRY_CONSTANTS.locality, contact_locality_note: ENQUIRY_CONSTANTS.addressLabel,
    enquiry_date: text(row.enquiry_date), enquiry_time: text(row.enquiry_time),
    probe_message: message, enquiry_record: message ? '' : record,
    seller_declared: hasVendorDeclaration(probe) || explicitSale(message) || (!record && text(row.seller_declared) === 'yes'),
    communication_events: events,
  };
}

export async function loadDemoFacts(repo, row) {
  // Two parallel reads for old snapshots: no migration or mass recompile needed.
  // A missing source tab must never turn an existing listing into a broken link.
  const results = await Promise.allSettled([
    repo.getRecords('PROBES', 'probe_id'), repo.getRecords('COMMUNICATIONS', 'communication_id'),
  ]);
  const records = i => results[i].status === 'fulfilled' ? results[i].value : [];
  const probe = records(0).find(r => text(r.obj?.probe_id) === text(row.probe_id))?.obj || {};
  return buildDemoFacts(row, probe, records(1).map(r => r.obj));
}
