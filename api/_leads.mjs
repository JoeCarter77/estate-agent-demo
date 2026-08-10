// api/_leads.mjs — slug → prospect record lookup (item 10).
//
// Vercel does NOT turn `_`-prefixed files in /api into routes, and does not serve
// them as static assets, so phone / outreach columns stored here stay server-side.
// Only /api/lead exposes a record, and it returns page-facing fields only.
//
// Keyed on `Slug` (unique per row, e.g. "ashton-white-dxfw").
//
// ── HOW TO LOAD THE REAL LIST ──
// agent_leads_with_slugs.csv (144 rows) was NOT bundled with this repo. Drop the CSV
// in the project root and run:
//
//     node scripts/import-leads.mjs agent_leads_with_slugs.csv
//
// …which regenerates this file from the CSV. The single record below is a placeholder
// so the mechanism is testable before the import runs.
//
// Field mapping (CSV column → record key):
//   Firm          → company
//   Website       → url            (fed into the live scrape/train process)
//   Town          → town           (exclusivity line, item 5)
//   First Name    → first_name     (often blank → generic greeting)
//   Phone         → phone          (not used on-page; never exposed by /api/lead)
//   Probe Address → probe_address  (empty until the firm is probed)
//   Probe Sent    → probe_sent     (empty until the firm is probed)
//   Listing URL   → listing_url    (not used on-page)
//
// On probe completion: fill probe_address + probe_sent on the SAME record (same slug,
// same link). The evidence block (item 3) and hero headline (item 2) then populate.

export const LEADS = {
  'example-demo-0000': {
    company: 'Example Estate Agents',
    url: 'https://www.example.co.uk',
    town: 'Anytown',
    first_name: '',
    phone: '',
    probe_address: '',
    probe_sent: '',
    listing_url: ''
  }
};

export default LEADS;
