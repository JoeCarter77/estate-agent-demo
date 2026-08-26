// api/novus/personalisation.js — GET /api/novus/personalisation?probe_id=...
//                                 GET /api/novus/personalisation?agency_id=...
//                                 POST /api/novus/contacts/verify (via rewrite)
//                                 POST /api/novus/contacts/resolve (via rewrite)
//
// Read-only lookup for the PERSONALISATION row lib/personalisation-rebuild.mjs
// writes (via the existing /api/novus/intelligence/rebuild-all + cron finalize
// rebuild flow — this file never triggers generation, only reads what's
// already there). One row per probe_id; ?agency_id= returns that agency's
// most recently created row, since an agency can have more than one probe.
//
// This is the single feed point for Instantly variables and the demo compiler.
// Instantly owns the fixed templates; NOVUS supplies property_reference,
// email_observation and email_commercial_hook (Email 1) plus
// email_commercial_hook_email_2 (Email 2). All three email prose fields come
// from the row's one traceable DIAGNOSIS_FINDINGS selection, and each does a
// different job: what happened, why it matters commercially, and the one
// extra thing that changes how the enquiry reads. This route does not touch
// index.html/api/lead.js's separate legacy demo data source.
//
// Same NOVUS_BASIC_AUTH guard as the rest of /api/novus/*.

import { getRepo } from '../../lib/sheets.mjs';
import { NeverBounceError, verifyEmail } from '../../lib/neverbounce.mjs';
import { resolveAgencyContact, listResolutionBacklog } from '../../lib/contact-resolution.mjs';
import { requireAuth } from './_auth.mjs';

// Contact resolution can run owner web research, a Hunter Finder lookup and
// several Hunter Verifier checks in one invocation; 20s was sized for the read-only
// Personalisation GET alone. This is a ceiling, not a reservation — the GET
// path is unaffected.
export const maxDuration = 60;

// Vercel rewrites the internal contact-verification URL here with the marker
// below. Keeping this in an existing protected function avoids consuming a
// thirteenth Hobby-plan Serverless Function; this path never calls getRepo()
// and therefore does not read from or write to Google Sheets.
async function handleContactVerification(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    const verification = await verifyEmail(email);
    return res.status(200).json({ email, ...verification });
  } catch (err) {
    if (err instanceof NeverBounceError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('contacts/verify error:', err);
    return res.status(500).json({ error: 'Unable to verify email' });
  }
}

// Single-agency contact resolution — POST /api/novus/contacts/resolve.
//
// Rewritten here with its own marker for exactly the same reason as
// verify-contact above: /api/novus/* is already at Vercel Hobby's 12
// Serverless Function limit, so a new protected NOVUS action becomes another
// operation on an existing protected function rather than a thirteenth file.
//
// Body: { agency_id, dry_run? }. One agency per call — deliberately no
// "resolve everything" mode here. GET ?novus_operation=resolution-backlog
// lists the probed agencies a future bulk run would cover WITHOUT resolving
// any of them.
async function handleContactResolution(req, res) {
  const agencyId = typeof req.body?.agency_id === 'string' ? req.body.agency_id.trim() : '';
  if (!agencyId) return res.status(400).json({ error: 'Missing agency_id' });
  const dryRun = req.body?.dry_run === true;

  try {
    const result = await resolveAgencyContact(getRepo(), agencyId, { dryRun });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof NeverBounceError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('contacts/resolve error:', err);
    return res.status(500).json({ error: err.message || 'Unable to resolve contact' });
  }
}

// Read-only: what the later backlog run WOULD process. Resolves nothing.
async function handleResolutionBacklog(req, res) {
  try {
    const includeResolved = String(req.query?.include_resolved || '') === 'true';
    const agencies = await listResolutionBacklog(getRepo(), { includeResolved });
    return res.status(200).json({ count: agencies.length, agencies });
  } catch (err) {
    console.error('contacts/resolution-backlog error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list resolution backlog' });
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST' && req.query?.novus_operation === 'verify-contact') {
    if (!requireAuth(req, res)) return;
    return handleContactVerification(req, res);
  }
  if (req.method === 'POST' && req.query?.novus_operation === 'resolve-contact') {
    if (!requireAuth(req, res)) return;
    return handleContactResolution(req, res);
  }
  if (req.method === 'GET' && req.query?.novus_operation === 'resolution-backlog') {
    if (!requireAuth(req, res)) return;
    return handleResolutionBacklog(req, res);
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const probeId = (req.query?.probe_id || '').trim();
  const agencyId = (req.query?.agency_id || '').trim();
  if (!probeId && !agencyId) {
    return res.status(400).json({ error: 'Missing probe_id or agency_id' });
  }

  try {
    const repo = getRepo();

    if (probeId) {
      const record = await repo.findById('PERSONALISATION', 'probe_id', probeId);
      if (!record) return res.status(404).json({ error: 'No Personalisation found for this probe (probe may not be diagnosed yet)' });
      return res.status(200).json({ personalisation: record.obj });
    }

    const records = await repo.getRecords('PERSONALISATION', 'probe_id');
    const forAgency = records.filter((r) => r.obj.agency_id === agencyId);
    if (forAgency.length === 0) {
      return res.status(404).json({ error: 'No Personalisation found for this agency' });
    }
    forAgency.sort((a, b) => new Date(b.obj.created_at) - new Date(a.obj.created_at));
    return res.status(200).json({ personalisation: forAgency[0].obj });
  } catch (err) {
    console.error('personalisation (get) error:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch personalisation' });
  }
}
