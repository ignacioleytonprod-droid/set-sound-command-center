const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://ignacioleytonprod-droid.github.io')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origen no autorizado por CORS.'));
  }
}));
app.use(express.json({ limit: '16kb' }));

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Se alcanzó el límite temporal de consultas. Inténtalo más tarde.' }
});

function passwordsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function getGeminiModel() {
  // Render's GEMINI_MODEL should be a model ID like "gemini-2.0-flash".
  // Accept "models/<id>" too, but avoid constructing an invalid models/models/<id> path.
  const configured = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
  const model = configured.replace(/^models\//i, '');
  if (!model || model.includes('/') || model.includes(':')) {
    throw new Error('GEMINI_MODEL debe ser solo el ID del modelo, por ejemplo gemini-2.0-flash; no incluyas "models/" ni una URL.');
  }
  return model;
}

async function callGemini(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('El administrador aún no configuró la clave de Gemini.');
  const model = getGeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Do not log request headers, API keys, or full upstream request data.
    console.error('Gemini upstream error:', response.status, data?.error?.message || 'Unknown error');
    throw new Error('Gemini no pudo procesar la consulta. Revisa que GEMINI_MODEL sea un ID disponible y que la clave tenga acceso.');
  }
  return data?.candidates?.[0]?.content?.parts?.map(part => part.text).join('\n') || 'Sin respuesta disponible.';
}

async function callClaude(message) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('El administrador aún no configuró la clave de Claude.');
  const model = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: 'Eres un asistente experto para la producción audiovisual y operaciones de una productora.',
      messages: [{ role: 'user', content: message }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Claude upstream error:', response.status, data?.error?.message || 'Unknown error');
    throw new Error('Claude no pudo procesar la consulta. Revisa la clave y el modelo configurado.');
  }
  return data?.content?.map(part => part.text || '').join('\n') || 'Sin respuesta disponible.';
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'set-sound-ai-api', time: new Date().toISOString() });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const expectedPassword = process.env.DASHBOARD_ACCESS_PASSWORD;
    if (!expectedPassword) {
      return res.status(503).json({ ok: false, error: 'El acceso privado aún no está configurado en el servidor.' });
    }

    const authorization = req.get('authorization') || '';
    const providedPassword = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!passwordsMatch(providedPassword, expectedPassword)) {
      return res.status(401).json({ ok: false, error: 'Contraseña de acceso incorrecta o no ingresada.' });
    }

    const { provider, message, conversationId } = req.body || {};
    if (!['gemini', 'claude'].includes(provider)) {
      return res.status(400).json({ error: 'Proveedor inválido. Usa "gemini" o "claude".' });
    }
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
    }
    if (message.length > 4000) {
      return res.status(413).json({ error: 'La consulta supera el límite de 4000 caracteres.' });
    }

    const reply = provider === 'gemini' ? await callGemini(message.trim()) : await callClaude(message.trim());
    return res.json({
      ok: true,
      provider,
      conversationId: typeof conversationId === 'string' ? conversationId : `conv_${Date.now()}`,
      reply
    });
  } catch (error) {
    console.error('AI request failed:', error);
    return res.status(502).json({ ok: false, error: error.message || 'Error en el backend de IA.' });
  }
});

app.listen(PORT, () => console.log(`Backend listo en puerto ${PORT}`));
