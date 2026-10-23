// Vercel serverless function: /api/image
// Image translator and image analyzer, using Gemini.
//
// Vercel settings (Project → Settings → Environment Variables):
//   GEMINI_API_KEY  = your Gemini API key (required)
//   GEMINI_MODELS   = comma-separated Flash model names, tried in order (optional)
//
// Request body (JSON):
//   image : data URL of the photo, e.g. "data:image/jpeg;base64,...."
//   from  : source language name (optional)
//   to    : target language name, e.g. "Urdu"
//   mode  : "analyze" (description + text in image + translation) or "translate" (translation only)
//   text  : optional note from the user
//
// Response (JSON): { translation, model } or { error }

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function getModelList() {
  const raw = process.env.GEMINI_MODELS;
  if (!raw || !raw.trim()) return DEFAULT_MODELS;
  const list = raw.split(',').map((m) => m.trim()).filter(Boolean);
  return [...new Set(list)];
}

function parseImage(dataUrl) {
  const match = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) return null;
  return { mimeType, data: match[2] };
}

function buildPrompt(mode, to, from, note) {
  const sourceName = from || 'the language shown in the image';
  const noteLine = note ? `\nThe user also wrote this note: ${note}\n` : '';

  if (mode === 'analyze') {
    return (
      `Look carefully at this image. Reply in ${to} with these three parts:\n` +
      `1. Description: briefly describe what the image shows.\n` +
      `2. Text in image: copy any text visible in the image, in its original language. If there is none, write "None".\n` +
      `3. Translation: translate that visible text from ${sourceName} into ${to}. If there is none, write "None".\n` +
      noteLine
    );
  }

  return (
    `Read all the text visible in this image and translate it from ${sourceName} to ${to}. ` +
    `Return only the translated text, without any explanation, notes or quotation marks. ` +
    `If there is no text, briefly describe the image in ${to} instead.` +
    noteLine
  );
}

async function callGemini(model, apiKey, parts) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({ contents: [{ parts }] }),
    }
  );

  let data = {};
  try {
    data = await response.json();
  } catch (e) {
    data = {};
  }

  if (!response.ok) {
    const message = data?.error?.message || `Model ${model} returned status ${response.status}`;
    return { ok: false, message };
  }

  const output = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!output) {
    return { ok: false, message: `Model ${model} returned an empty response` };
  }

  return { ok: true, output, model };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is not configured: GEMINI_API_KEY is missing.' });
  }

  const body = req.body || {};
  const image = parseImage(body.image);
  const to = typeof body.to === 'string' ? body.to : '';
  const from = typeof body.from === 'string' ? body.from : '';
  const note = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
  const mode = body.mode === 'translate' ? 'translate' : 'analyze';

  if (!image) {
    return res.status(400).json({ error: 'Image must be a JPG, PNG, WEBP or GIF file.' });
  }
  if (!to) {
    return res.status(400).json({ error: 'Please choose a target language.' });
  }

  const parts = [
    { inlineData: { mimeType: image.mimeType, data: image.data } },
    { text: buildPrompt(mode, to, from, note) },
  ];

  const errors = [];
  for (const model of getModelList()) {
    try {
      const result = await callGemini(model, apiKey, parts);
      if (result.ok) {
        return res.status(200).json({ translation: result.output, model: result.model });
      }
      errors.push(result.message);
      console.warn(`Model ${model} failed:`, result.message);
    } catch (err) {
      errors.push(`Model ${model} connection error`);
      console.error(`Model ${model} connection error:`, err);
    }
  }

  return res.status(502).json({
    error: 'Could not process the image. Please try again later.',
    details: errors.slice(-3),
  });
}
