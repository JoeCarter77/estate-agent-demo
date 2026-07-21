// api/scrape.js — Vercel Serverless Function
// POST /api/scrape
// Body: { url }
// Returns: { text } or { error }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  };

  // Keywords that score a link as high-value for a gym site
  const HIGH_VALUE = ['class', 'schedule', 'timetable', 'price', 'membership', 'join', 'about',
    'coach', 'trainer', 'instructor', 'trial', 'contact', 'location', 'faq', 'bjj',
    'mma', 'boxing', 'judo', 'wrestling', 'programme', 'program', 'facility'];

  function scoreLink(href, base) {
    try {
      const u = new URL(href, base);
      if (u.origin !== new URL(base).origin) return -1; // external
      if (u.pathname === '/') return 0;
      const path = u.pathname.toLowerCase();
      let score = 1;
      HIGH_VALUE.forEach(kw => { if (path.includes(kw)) score += 2; });
      return score;
    } catch {
      return -1;
    }
  }

  function extractText(html) {
    // Strip scripts, styles, head — keep nav/footer as they often contain address/contact info
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text;
  }

  function extractLinks(html, base) {
    const links = new Set();
    const re = /href=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1], base);
        if (u.origin === new URL(base).origin) links.add(u.href);
      } catch {}
    }
    return [...links];
  }

  async function fetchPage(pageUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(pageUrl, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('html')) return null;
      return await r.text();
    } catch {
      return null;
    }
  }

  try {
    // Normalise URL
    const baseUrl = url.startsWith('http') ? url : `https://${url}`;

    // 1. Fetch homepage
    const homeHtml = await fetchPage(baseUrl);
    if (!homeHtml) {
      return res.status(200).json({ text: '' });
    }

    const homeText = extractText(homeHtml);
    const allLinks = extractLinks(homeHtml, baseUrl);

    // 2. Score and pick top sub-pages (max 5)
    const scored = allLinks
      .map(href => ({ href, score: scoreLink(href, baseUrl) }))
      .filter(l => l.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(l => l.href);

    // 3. Fetch sub-pages in parallel
    const subTexts = await Promise.all(
      scored.map(async (pageUrl) => {
        const html = await fetchPage(pageUrl);
        return html ? extractText(html) : '';
      })
    );

    // 4. Combine and deduplicate roughly
    const combined = [homeText, ...subTexts]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 12000); // cap before sending back

    return res.status(200).json({ text: combined });

  } catch (err) {
    console.error('Scrape error:', err);
    // Always return 200 so the chatbot degrades gracefully
    return res.status(200).json({ text: '' });
  }
}
