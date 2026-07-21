// api/chat.js — Vercel Serverless Function
// POST /api/chat
// Body: { messages, systemPrompt, agencyName, agencyUrl }
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, systemPrompt, agencyName, agencyUrl } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Use the fully-built system prompt from the frontend (includes scraped content + full instructions).
  // Fall back to a minimal prompt if somehow not provided.
  const system = systemPrompt || fallbackPrompt(agencyName, agencyUrl);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system,
        messages: messages.slice(-10) // last 10 msgs for context efficiency
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || "I'm not sure about that — let me take your details and the team will confirm.";
    return res.status(200).json({ reply });

  } catch (error) {
    console.error('Chat API error:', error);
    return res.status(500).json({ error: error.message || 'Chat failed' });
  }
}

// Only used if the frontend somehow doesn't send a systemPrompt
function fallbackPrompt(agencyName, agencyUrl) {
  return `You are the AI assistant for ${agencyName || 'this estate agency'}. Be friendly, concise, and helpful. Keep replies to 2-3 sentences. UK English only. Never invent specific prices, addresses, or property availability — if unsure, offer to take the enquirer's details for the team to confirm.`;
}
