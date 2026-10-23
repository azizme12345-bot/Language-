// Vercel serverless function: /api/translate
// The Gemini API key is read from the environment variable GEMINI_API_KEY
// (set in Vercel → Project → Settings → Environment Variables).
// The key never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is not configured: GEMINI_API_KEY is missing.' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const from = typeof body.from === 'string' && body.from ? body.from : 'the detected language';
  const to = typeof body.to === 'string' ? body.to : '';

  if (!text) {
    return res.status(400).json({ error: 'Please enter some text to translate.' });
  }
  if (!to) {
    return res.status(400).json({ error: 'Please choose a target language.' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Text is too long. Please keep it under 5000 characters.' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt =
    `Translate the following text from ${from} to ${to}. ` +
    `Return only the translated text, without any explanation, notes or quotation marks.\n\n` +
    `Text:\n${text}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || 'Translation service returned an error.';
      return res.status(response.status).json({ error: message });
    }

    const translated = (data?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('')
      .trim();

    if (!translated) {
      return res.status(502).json({ error: 'No translation was returned. Please try again.' });
    }

    return res.status(200).json({ translation: translated });
  } catch (err) {
    console.error('Translate API error:', err);
    return res.status(500).json({ error: 'Could not connect to the translation service.' });
  }
}
