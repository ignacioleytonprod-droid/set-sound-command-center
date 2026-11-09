const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { rateLimit } = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://ignacioleytonprod-droid.github.io')
  .split(',').map(origin => origin.trim()).filter(Boolean);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } })
  : null;
let databaseReady = false;

app.set('trust proxy', 1);
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origen no autorizado por CORS.'));
} }));
app.use(express.json({ limit: '32kb' }));

const chatLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Se alcanzó el límite temporal de consultas. Inténtalo más tarde.' } });
const eventsLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas operaciones en poco tiempo. Inténtalo más tarde.' } });

function passwordsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireDashboardPassword(req, res, next) {
  const expected = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!expected) return res.status(503).json({ ok: false, error: 'El acceso privado aún no está configurado en el servidor.' });
  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!passwordsMatch(provided, expected)) return res.status(401).json({ ok: false, error: 'Contraseña de acceso incorrecta o no ingresada.' });
  next();
}
function requireDatabase(_req, res, next) {
  if (!pool || !databaseReady) return res.status(503).json({ ok: false, error: 'La base de datos compartida aún no está configurada o disponible.' });
  next();
}
function getGeminiModel() {
  const configured = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
  const model = configured.replace(/^models\//i, '');
  if (!model || model.includes('/') || model.includes(':')) throw new Error('GEMINI_MODEL debe ser solo el ID del modelo, sin "models/" ni URL.');
  return model;
}
async function callGemini(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('El administrador aún no configuró la clave de Gemini.');
  const model = getGeminiModel();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 800 } }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Gemini upstream error:', response.status, data?.error?.message || 'Unknown error');
    throw new Error('Gemini no pudo procesar la consulta. Revisa modelo y acceso de la clave.');
  }
  return data?.candidates?.[0]?.content?.parts?.map(part => part.text).join('\n') || 'Sin respuesta disponible.';
}
async function callClaude(message) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('El administrador aún no configuró la clave de Claude.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022', max_tokens: 800,
      system: 'Eres un asistente experto para la producción audiovisual y operaciones de una productora.', messages: [{ role: 'user', content: message }] }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Claude upstream error:', response.status, data?.error?.message || 'Unknown error');
    throw new Error('Claude no pudo procesar la consulta. Revisa la clave y el modelo configurado.');
  }
  return data?.content?.map(part => part.text || '').join('\n') || 'Sin respuesta disponible.';
}

const EVENT_COLUMNS = `id, title, event_date AS "eventDate", cell_ids AS "cellIds", status, location, notes,
  income_clp AS "incomeClp", expense_clp AS "expenseClp", created_at AS "createdAt", updated_at AS "updatedAt"`;
function validateEvent(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const eventDate = typeof body.eventDate === 'string' ? body.eventDate : '';
  const cellIds = Array.isArray(body.cellIds) ? [...new Set(body.cellIds.map(Number))] : [];
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && !Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`));
  const incomeClp = body.incomeClp === '' || body.incomeClp == null ? 0 : Number(body.incomeClp);
  const expenseClp = body.expenseClp === '' || body.expenseClp == null ? 0 : Number(body.expenseClp);
  if (!title || title.length > 160) return 'El título es obligatorio y debe tener máximo 160 caracteres.';
  if (!validDate) return 'Indica una fecha válida.';
  if (!cellIds.length || cellIds.some(id => ![1, 2, 3, 4].includes(id))) return 'Asigna el evento a una o más células válidas.';
  if (!['planned', 'in-progress', 'done', 'cancelled'].includes(body.status)) return 'Estado de evento inválido.';
  if (!Number.isSafeInteger(incomeClp) || incomeClp < 0 || incomeClp > 1000000000000) return 'El ingreso debe ser un monto CLP entero entre 0 y 1.000.000.000.000.';
  if (!Number.isSafeInteger(expenseClp) || expenseClp < 0 || expenseClp > 1000000000000) return 'El egreso debe ser un monto CLP entero entre 0 y 1.000.000.000.000.';
  const location = typeof body.location === 'string' ? body.location.trim().slice(0, 200) : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';
  return { title, eventDate, cellIds, status: body.status, location, notes, incomeClp, expenseClp };
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'set-sound-ai-api', database: databaseReady ? 'ready' : 'not_configured' }));

app.get('/api/events', eventsLimiter, requireDashboardPassword, requireDatabase, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY event_date ASC, id ASC`);
    res.json({ ok: true, events: result.rows.map(row => ({ ...row, incomeClp: Number(row.incomeClp), expenseClp: Number(row.expenseClp) })) });
  } catch (error) { console.error('Event list failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudieron cargar los eventos.' }); }
});
app.post('/api/events', eventsLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const event = validateEvent(req.body || {});
  if (typeof event === 'string') return res.status(400).json({ ok: false, error: event });
  try {
    const result = await pool.query(`INSERT INTO events (title,event_date,cell_ids,status,location,notes,income_clp,expense_clp)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${EVENT_COLUMNS}`,
      [event.title, event.eventDate, JSON.stringify(event.cellIds), event.status, event.location, event.notes, event.incomeClp, event.expenseClp]);
    res.status(201).json({ ok: true, event: { ...result.rows[0], incomeClp: Number(result.rows[0].incomeClp), expenseClp: Number(result.rows[0].expenseClp) } });
  } catch (error) { console.error('Event create failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo guardar el evento.' }); }
});
app.put('/api/events/:id', eventsLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID de evento inválido.' });
  const event = validateEvent(req.body || {});
  if (typeof event === 'string') return res.status(400).json({ ok: false, error: event });
  try {
    const result = await pool.query(`UPDATE events SET title=$1,event_date=$2,cell_ids=$3,status=$4,location=$5,notes=$6,income_clp=$7,expense_clp=$8,updated_at=NOW() WHERE id=$9 RETURNING ${EVENT_COLUMNS}`,
      [event.title, event.eventDate, JSON.stringify(event.cellIds), event.status, event.location, event.notes, event.incomeClp, event.expenseClp, id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, error: 'No se encontró ese evento.' });
    res.json({ ok: true, event: { ...result.rows[0], incomeClp: Number(result.rows[0].incomeClp), expenseClp: Number(result.rows[0].expenseClp) } });
  } catch (error) { console.error('Event update failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo actualizar el evento.' }); }
});
app.delete('/api/events/:id', eventsLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID de evento inválido.' });
  try {
    const result = await pool.query('DELETE FROM events WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, error: 'No se encontró ese evento.' });
    res.json({ ok: true });
  } catch (error) { console.error('Event delete failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo eliminar el evento.' }); }
});

app.post('/api/chat', chatLimiter, requireDashboardPassword, async (req, res) => {
  try {
    const { provider, message, conversationId } = req.body || {};
    if (!['gemini', 'claude'].includes(provider)) return res.status(400).json({ error: 'Proveedor inválido. Usa "gemini" o "claude".' });
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
    if (message.length > 4000) return res.status(413).json({ error: 'La consulta supera el límite de 4000 caracteres.' });
    const reply = provider === 'gemini' ? await callGemini(message.trim()) : await callClaude(message.trim());
    res.json({ ok: true, provider, conversationId: typeof conversationId === 'string' ? conversationId : `conv_${Date.now()}`, reply });
  } catch (error) { console.error('AI request failed:', error); res.status(502).json({ ok: false, error: error.message || 'Error en el backend de IA.' }); }
});

async function start() {
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(160) NOT NULL,
        event_date DATE NOT NULL,
        cell_ids JSONB NOT NULL CHECK (jsonb_typeof(cell_ids) = 'array'),
        status VARCHAR(20) NOT NULL CHECK (status IN ('planned','in-progress','done','cancelled')),
        location VARCHAR(200) NOT NULL DEFAULT '',
        notes VARCHAR(2000) NOT NULL DEFAULT '',
        income_clp BIGINT NOT NULL DEFAULT 0 CHECK (income_clp >= 0),
        expense_clp BIGINT NOT NULL DEFAULT 0 CHECK (expense_clp >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      databaseReady = true;
      console.log('Shared events database ready.');
    } catch (error) { console.error('Database initialization failed:', error.message); }
  } else console.warn('DATABASE_URL is not configured; event endpoints are disabled.');
  app.listen(PORT, () => console.log(`Backend listo en puerto ${PORT}`));
}
start();
