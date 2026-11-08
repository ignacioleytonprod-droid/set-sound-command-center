const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const allowedProviders = ['gemini', 'claude'];

async function callGemini(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el servidor.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Error de Gemini');
  }

  return data?.candidates?.[0]?.content?.parts?.map(part => part.text).join('\n') || 'Sin respuesta disponible.';
}

async function callClaude(message) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('Falta CLAUDE_API_KEY en el servidor.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 800,
      system: 'Eres un asistente experto para la producción audiovisual y operaciones de una productora.',
      messages: [{ role: 'user', content: message }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Error de Claude');
  }

  return data?.content?.map(part => part.text || '').join('\n') || 'Sin respuesta disponible.';
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'set-sound-ai-api', time: new Date().toISOString() });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { provider, message, conversationId } = req.body || {};

    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ error: 'Proveedor inválido. Usa "gemini" o "claude".' });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
    }

    let reply;
    if (provider === 'gemini') {
      reply = await callGemini(message);
    } else {
      reply = await callClaude(message);
    }

    return res.json({
      ok: true,
      provider,
      conversationId: conversationId || `conv_${Date.now()}`,
      reply
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Error en el backend de IA.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});
