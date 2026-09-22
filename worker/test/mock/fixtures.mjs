// worker/test/mock/fixtures.mjs — the agencies, branches and listings the
// scenario tests run against. Shapes mirror the real AGENCIES columns the
// Prober reads (agency_id, agency_name, rightmove_sales_branch_url,
// probe_sent, email_verification_status, updated_at).

const branchUrl = (slug, id) => `https://www.rightmove.co.uk/estate-agents/agent/${slug}/Area-${id}.html`;

export function agency(id, name, slug, branchId, overrides = {}) {
  return {
    agency_id: id,
    agency_name: name,
    rightmove_sales_branch_url: branchUrl(slug, branchId),
    probe_sent: '',
    email_verification_status: 'VALID',
    outreach_contact_email: `hello@${slug.toLowerCase()}.test`,
    updated_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

export function listing(id, propertyType, address, extra = {}) {
  return { id: String(id), propertyType, address, price: '£450,000', channel: 'RES_BUY', ...extra };
}

export function property(id, { address, branchName, agentSlug, branchId, title, description = '' }) {
  return {
    address, branchName, agentSlug, branchId, description,
    title: title || `3 bedroom house for sale in ${address}`,
    price: '£450,000',
  };
}

// The standard world: one healthy agency with ordinary residential stock,
// followed by a lettings-only agency, a land-only agency and one with no
// suitable properties at all.
export function standardWorld() {
  return {
    agencies: [
      agency('ag-alpha-1', 'Alpha Residential', 'Alpha-Residential', '11111'),
      agency('ag-lettings-2', 'Bravo Lettings', 'Bravo-Lettings', '22222'),
      agency('ag-land-3', 'Charlie Land', 'Charlie-Land', '33333'),
      agency('ag-empty-4', 'Delta Property', 'Delta-Property', '44444'),
      agency('ag-done-5', 'Echo Estates', 'Echo-Estates', '55555', { probe_sent: 'YES' }),
      agency('ag-unverified-6', 'Foxtrot Homes', 'Foxtrot-Homes', '66666', { email_verification_status: 'INVALID' }),
      agency('ag-second-7', 'Golf Residential', 'Golf-Residential', '77777'),
    ],
    branches: {
      11111: {
        name: 'Alpha Residential, Testtown',
        forSale: 3, toRent: 1,
        listings: [
          listing(900001, 'Land', 'Development Plot, Testtown'),
          listing(900002, 'House', 'Farmers Close, Testtown'),
          listing(900003, 'Flat', 'Ovaltine Drive, Testtown'),
        ],
      },
      22222: { name: 'Bravo Lettings, Testtown', forSale: 0, toRent: 14, listings: [listing(900010, 'Flat', 'Rental Way', { channel: 'RES_LET' })] },
      33333: {
        name: 'Charlie Land, Testtown', forSale: 2, toRent: 0,
        listings: [listing(900020, 'Land', 'Field One'), listing(900021, 'Land', 'Field Two')],
      },
      44444: { name: 'Delta Property, Testtown', forSale: 0, toRent: 0, listings: [] },
      77777: { name: 'Golf Residential, Testtown', forSale: 1, toRent: 0, listings: [listing(900030, 'Bungalow', 'Second Lane, Testtown')] },
    },
    properties: {
      900002: property(900002, { address: 'Farmers Close, Testtown', branchName: 'Alpha Residential, Testtown', agentSlug: 'Alpha-Residential', branchId: '11111' }),
      900003: property(900003, { address: 'Ovaltine Drive, Testtown', branchName: 'Alpha Residential, Testtown', agentSlug: 'Alpha-Residential', branchId: '11111', title: '2 bedroom flat for sale in Ovaltine Drive' }),
      900030: property(900030, { address: 'Second Lane, Testtown', branchName: 'Golf Residential, Testtown', agentSlug: 'Golf-Residential', branchId: '77777' }),
    },
  };
}

export const APPROVED_IDENTITY = {
  firstName: 'Joe',
  lastName: 'Probe',
  email: 'probe@novus.test',
  phone: '+447575333064',
  postcode: 'CM12 0AA',
};
