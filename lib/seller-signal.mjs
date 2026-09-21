// Evidence-only seller-signal classification. It never guesses that a
// valuation was appropriate; it only records what the agency actually said.
import { hasVendorDeclaration } from './vendor-intent.mjs';
import { isHumanCommunication } from './classification.mjs';

const content = (row) => [row.subject, row.body_text, row.transcript, row.raw_content]
  .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
const SELLER = /\b(sell(?:ing|er)?|sale|valuation|market(?:ing|ed)?|market appraisal|apprais(?:al|e)|your (?:current|own) property|property to sell)\b/i;
const POSITION = /\b(?:what|where|when|how)\b[^?.!]{0,70}\b(?:sell|sale|property|market)|\b(?:is|are) you (?:selling|on the market|already marketing)|\b(?:tell us|let us know)[^?.!]{0,70}\b(?:sell|property|market)\b/i;
const VALUATION = /\b(?:book|arrange|offer|schedule)[^?.!]{0,70}\b(?:valuation|appraisal)|\bvaluation\b[^?.!]{0,70}\b(?:appointment|visit|slot|time)\b/i;

export function classifySellerSignal(probe, communications = []) {
  if (!hasVendorDeclaration(probe)) return { seller_recognition: '', seller_follow_up: 'not_applicable' };
  const mentions = communications.filter(isHumanCommunication).filter((row) => SELLER.test(content(row)));
  if (!mentions.length) return { seller_recognition: 'none', seller_follow_up: 'unclear' };
  const combined = mentions.map(content).join('\n');
  if (VALUATION.test(combined)) return { seller_recognition: 'valuation_offered', seller_follow_up: 'followed_up' };
  if (POSITION.test(combined)) return { seller_recognition: 'asked_position', seller_follow_up: 'followed_up' };
  return { seller_recognition: 'acknowledged', seller_follow_up: 'mentioned_only' };
}
