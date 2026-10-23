// Cloudflare Worker: serves the website and the API routes.
//
// Required in Cloudflare (Settings → Variables and Secrets):
//   GEMINI_API_KEY  → add as a SECRET
//   GEMINI_MODELS   → optional, comma-separated Flash model names, tried in order

const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];
const MAX_TEXT_LENGTH = 5000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getModelList(env) {
  const raw = env.GEMINI_MODELS;
  if (!raw || !raw.trim()) return DEFAULT_MODELS;
  const list = raw.split(',').map((m) => m.trim()).filter(Boolean);
  return [...new Set(list)];
}

function parseDataUrl(dataUrl, allowedTypes) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!allowedTypes.includes(mimeType)) return null;
  return { mimeType, data: match[2] };
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
    return { ok: false, message: data?.error?.message || `Model ${model} returned status ${response.status}` };
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

// Tries each model in order until one works
async function runGemini(env, parts) {
  if (!env.GEMINI_API_KEY) {
    return { ok: false, status: 500, error: 'Server is not configured: GEMINI_API_KEY is missing.' };
  }

  const errors = [];
  for (const model of getModelList(env)) {
    try {
      const result = await callGemini(model, env.GEMINI_API_KEY, parts);
      if (result.ok) return result;
      errors.push(result.message);
    } catch (err) {
      errors.push(`Model ${model} connection error`);
    }
  }

  return { ok: false, status: 502, error: 'All models failed. Please try again later.', details: errors.slice(-3) };
}

function translatePrompt(from, to, text) {
  const sourceName = from || 'the detected language';
  return (
    `Translate the following text from ${sourceName} to ${to}. ` +
    `Return only the translated text, without any explanation, notes or quotation marks.\n\n` +
    `Text:\n${text}`
  );
}

function imagePrompt(mode, from, to, note) {
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

function transcribePrompt(language) {
  return (
    `Transcribe the speech in this audio exactly as it was spoken. ` +
    `The speaker may be using ${language}. Write the words in the same script the speaker used. ` +
    `Return only the transcription, with no explanation, labels or timestamps. ` +
    `If there is no speech, return nothing.`
  );
}

async function handleTranslate(request, env) {
  const body = await request.json();
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';

  if (!to) return json({ error: 'Please choose a target language.' }, 400);
  if (!text) return json({ error: 'Please enter some text to translate.' }, 400);
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: 'Text is too long. Please keep it under 5000 characters.' }, 400);
  }

  const result = await runGemini(env, [{ text: translatePrompt(from, to, text) }]);
  if (!result.ok) return json({ error: result.error, details: result.details }, result.status);
  return json({ translation: result.output, model: result.model });
}

async function handleImage(request, env) {
  const body = await request.json();
  const image = parseDataUrl(body.image, ALLOWED_IMAGE_TYPES);
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  const note = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : '';
  const mode = body.mode === 'translate' ? 'translate' : 'analyze';

  if (!image) return json({ error: 'Image must be a JPG, PNG, WEBP or GIF file.' }, 400);
  if (!to) return json({ error: 'Please choose a target language.' }, 400);

  const parts = [
    { inlineData: { mimeType: image.mimeType, data: image.data } },
    { text: imagePrompt(mode, from, to, note) },
  ];

  const result = await runGemini(env, parts);
  if (!result.ok) return json({ error: result.error, details: result.details }, result.status);
  return json({ translation: result.output, model: result.model });
}

async function handleTranscribe(request, env) {
  const body = await request.json();
  const audio = parseDataUrl(body.audio, ALLOWED_AUDIO_TYPES);
  const language = typeof body.language === 'string' && body.language ? body.language : 'any language';

  if (!audio) return json({ error: 'Recording is missing or in an unsupported format.' }, 400);

  const parts = [
    { inlineData: { mimeType: audio.mimeType, data: audio.data } },
    { text: transcribePrompt(language) },
  ];

  const result = await runGemini(env, parts);
  if (!result.ok) {
    return json({ error: 'Could not convert speech to text. Please speak clearly and try again.', details: result.details }, result.status);
  }
  return json({ text: result.output, model: result.model });
}

const API_ROUTES = {
  '/api/translate': handleTranslate,
  '/api/image': handleImage,
  '/api/transcribe': handleTranscribe,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const handler = API_ROUTES[url.pathname];
      if (!handler) return json({ error: 'Not found' }, 404);
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

      try {
        return await handler(request, env);
      } catch (err) {
        console.error('API error:', err);
        return json({ error: 'Invalid request or server error.' }, 400);
      }
    }

    // Everything else is the website (index.html, app-extras.js)
    return env.ASSETS.fetch(request);
  },
};
