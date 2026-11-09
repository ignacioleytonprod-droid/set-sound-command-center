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
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas operaciones en poco tiempo. Inténtalo más tarde.' } });

function passwordsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireDashboardPassword(req, res, next) {
  const expected = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!expected) return res.status(503).json({ ok: false, error: 'El acceso privado aún no está configurado en el servidor.' });
  const authorization = req.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!passwordsMatch(provided, expected)) return res.status(401).json({ ok: false, error: 'Contraseña de acceso incorrecta o no ingresada.' });
  next();
}
function requireDatabase(_req, res, next) {
  if (!pool || !databaseReady) return res.status(503).json({ ok: false, error: 'La base de datos compartida aún no está configurada o disponible.' });
  next();
}
function getGeminiModel() {
  const model = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim().replace(/^models\//i, '');
  if (!model || model.includes('/') || model.includes(':')) throw new Error('GEMINI_MODEL debe ser solo el ID del modelo, sin "models/" ni URL.');
  return model;
}
async function callGemini(message) {
  if (!process.env.GEMINI_API_KEY) throw new Error('El administrador aún no configuró la clave de Gemini.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getGeminiModel())}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 800 } }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error('Gemini upstream error:', response.status, data?.error?.message || 'Unknown error'); throw new Error('Gemini no pudo procesar la consulta. Revisa modelo y acceso de la clave.'); }
  return data?.candidates?.[0]?.content?.parts?.map(part => part.text).join('\n') || 'Sin respuesta disponible.';
}
async function callClaude(message) {
  if (!process.env.CLAUDE_API_KEY) throw new Error('El administrador aún no configuró la clave de Claude.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022', max_tokens: 800,
      system: 'Eres un asistente experto para la producción audiovisual y operaciones de una productora.', messages: [{ role: 'user', content: message }] }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error('Claude upstream error:', response.status, data?.error?.message || 'Unknown error'); throw new Error('Claude no pudo procesar la consulta. Revisa la clave y el modelo configurado.'); }
  return data?.content?.map(part => part.text || '').join('\n') || 'Sin respuesta disponible.';
}

const EVENT_COLUMNS = `id, title, event_date AS "eventDate", cell_ids AS "cellIds", status, location, notes,
  income_clp AS "incomeClp", expense_clp AS "expenseClp", created_at AS "createdAt", updated_at AS "updatedAt"`;
const LOG_COLUMNS = `l.id, l.event_id AS "eventId", l.cell_id AS "cellId", l.author, l.action, l.message,
  l.created_at AS "createdAt", COALESCE(e.title,l.event_title_snapshot) AS "eventTitle"`;
function validateEvent(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const eventDate = typeof body.eventDate === 'string' ? body.eventDate : '';
  const cellIds = Array.isArray(body.cellIds) ? [...new Set(body.cellIds.map(Number))] : [];
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? new Date(`${eventDate}T00:00:00Z`) : null;
  const validDate = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === eventDate;
  const incomeClp = body.incomeClp == null || body.incomeClp === '' ? 0 : Number(body.incomeClp);
  const expenseClp = body.expenseClp == null || body.expenseClp === '' ? 0 : Number(body.expenseClp);
  if (!title || title.length > 160) return 'El título es obligatorio y debe tener máximo 160 caracteres.';
  if (!validDate) return 'Indica una fecha válida.';
  if (!cellIds.length || cellIds.some(id => ![1, 2, 3, 4].includes(id))) return 'Asigna el evento a una o más células válidas.';
  if (!['planned', 'in-progress', 'done', 'cancelled'].includes(body.status)) return 'Estado de evento inválido.';
  if (!Number.isSafeInteger(incomeClp) || incomeClp < 0 || incomeClp > 1000000000000) return 'El ingreso debe ser un monto CLP entero válido.';
  if (!Number.isSafeInteger(expenseClp) || expenseClp < 0 || expenseClp > 1000000000000) return 'El egreso debe ser un monto CLP entero válido.';
  return { title, eventDate, cellIds, status: body.status,
    location: typeof body.location === 'string' ? body.location.trim().slice(0, 200) : '',
    notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '', incomeClp, expenseClp };
}
function actorName(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'Equipo'; }
function entryCell(event) { return event.cellIds.includes(2) ? 2 : event.cellIds[0]; }
async function logEvent(client, event, action, author) {
  const messages = {
    created: `Creó el evento «${event.title}» (${event.status}).`,
    updated: `Actualizó el evento «${event.title}» (${event.status}).`,
    deleted: `Eliminó el evento «${event.title}».`
  };
  await client.query(`INSERT INTO bitacora (event_id,event_title_snapshot,cell_id,author,action,message)
    VALUES ($1,$2,$3,$4,$5,$6)`, [action === 'deleted' ? null : event.id, event.title, entryCell(event), author, action, messages[action]]);
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'set-sound-ai-api', database: databaseReady ? 'ready' : 'not_configured' }));

app.get('/api/events', writeLimiter, requireDashboardPassword, requireDatabase, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY event_date ASC, id ASC`);
    res.json({ ok: true, events: result.rows.map(row => ({ ...row, incomeClp: Number(row.incomeClp), expenseClp: Number(row.expenseClp) })) });
  } catch (error) { console.error('Event list failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudieron cargar los eventos.' }); }
});
app.post('/api/events', writeLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const event = validateEvent(req.body || {});
  if (typeof event === 'string') return res.status(400).json({ ok: false, error: event });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO events (title,event_date,cell_ids,status,location,notes,income_clp,expense_clp)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${EVENT_COLUMNS}`,
      [event.title, event.eventDate, JSON.stringify(event.cellIds), event.status, event.location, event.notes, event.incomeClp, event.expenseClp]);
    const saved = { ...result.rows[0], incomeClp: Number(result.rows[0].incomeClp), expenseClp: Number(result.rows[0].expenseClp) };
    await logEvent(client, { ...event, id: saved.id }, 'created', actorName(req.body.author));
    await client.query('COMMIT');
    res.status(201).json({ ok: true, event: saved });
  } catch (error) { await client.query('ROLLBACK'); console.error('Event create failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo guardar el evento.' }); }
  finally { client.release(); }
});
app.put('/api/events/:id', writeLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID de evento inválido.' });
  const event = validateEvent(req.body || {});
  if (typeof event === 'string') return res.status(400).json({ ok: false, error: event });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE events SET title=$1,event_date=$2,cell_ids=$3,status=$4,location=$5,notes=$6,income_clp=$7,expense_clp=$8,updated_at=NOW() WHERE id=$9 RETURNING ${EVENT_COLUMNS}`,
      [event.title, event.eventDate, JSON.stringify(event.cellIds), event.status, event.location, event.notes, event.incomeClp, event.expenseClp, id]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'No se encontró ese evento.' }); }
    const saved = { ...result.rows[0], incomeClp: Number(result.rows[0].incomeClp), expenseClp: Number(result.rows[0].expenseClp) };
    await logEvent(client, { ...event, id: saved.id }, 'updated', actorName(req.body.author));
    await client.query('COMMIT');
    res.json({ ok: true, event: saved });
  } catch (error) { await client.query('ROLLBACK'); console.error('Event update failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo actualizar el evento.' }); }
  finally { client.release(); }
});
app.delete('/api/events/:id', writeLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID de evento inválido.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id=$1 FOR UPDATE`, [id]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'No se encontró ese evento.' }); }
    const event = result.rows[0];
    await logEvent(client, { ...event, cellIds: event.cellIds }, 'deleted', actorName(req.body?.author));
    await client.query('DELETE FROM events WHERE id=$1', [id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); console.error('Event delete failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo eliminar el evento.' }); }
  finally { client.release(); }
});

app.get('/api/bitacora', writeLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const cellId = req.query.cellId == null || req.query.cellId === '' ? null : Number(req.query.cellId);
  const eventId = req.query.eventId == null || req.query.eventId === '' ? null : Number(req.query.eventId);
  if (cellId !== null && ![1, 2, 3, 4].includes(cellId)) return res.status(400).json({ ok: false, error: 'Filtro de célula inválido.' });
  if (eventId !== null && (!Number.isSafeInteger(eventId) || eventId < 1)) return res.status(400).json({ ok: false, error: 'Filtro de evento inválido.' });
  try {
    const result = await pool.query(`SELECT ${LOG_COLUMNS} FROM bitacora l LEFT JOIN events e ON e.id=l.event_id
      WHERE ($1::smallint IS NULL OR l.cell_id=$1) AND ($2::bigint IS NULL OR l.event_id=$2)
      ORDER BY l.created_at DESC,l.id DESC LIMIT 200`, [cellId, eventId]);
    res.json({ ok: true, entries: result.rows });
  } catch (error) { console.error('Log list failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo cargar la bitácora.' }); }
});
app.post('/api/bitacora', writeLimiter, requireDashboardPassword, requireDatabase, async (req, res) => {
  const body = req.body || {};
  const author = actorName(body.author);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const cellId = Number(body.cellId);
  const eventId = body.eventId == null || body.eventId === '' ? null : Number(body.eventId);
  if (!message || message.length > 3000) return res.status(400).json({ ok: false, error: 'La nota es obligatoria y debe tener máximo 3000 caracteres.' });
  if (![1, 2, 3, 4].includes(cellId)) return res.status(400).json({ ok: false, error: 'Selecciona una célula válida.' });
  if (eventId !== null && (!Number.isSafeInteger(eventId) || eventId < 1)) return res.status(400).json({ ok: false, error: 'El evento seleccionado no es válido.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let eventTitle = null;
    if (eventId !== null) {
      const event = await client.query('SELECT title,cell_ids FROM events WHERE id=$1', [eventId]);
      if (!event.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: 'No se encontró el evento asociado.' }); }
      if (!event.rows[0].cell_ids.map(Number).includes(cellId)) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: 'El evento no está vinculado a la célula seleccionada.' }); }
      eventTitle = event.rows[0].title;
    }
    const result = await client.query(`INSERT INTO bitacora (event_id,event_title_snapshot,cell_id,author,action,message)
      VALUES ($1,$2,$3,$4,'note',$5) RETURNING id,event_id AS "eventId",cell_id AS "cellId",author,action,message,created_at AS "createdAt"`,
      [eventId, eventTitle, cellId, author, message]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, entry: { ...result.rows[0], eventTitle } });
  } catch (error) { await client.query('ROLLBACK'); console.error('Log create failed:', error.message); res.status(500).json({ ok: false, error: 'No se pudo guardar la nota en la bitácora.' }); }
  finally { client.release(); }
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
        id BIGSERIAL PRIMARY KEY, title VARCHAR(160) NOT NULL, event_date DATE NOT NULL,
        cell_ids JSONB NOT NULL CHECK (jsonb_typeof(cell_ids)='array'),
        status VARCHAR(20) NOT NULL CHECK (status IN ('planned','in-progress','done','cancelled')),
        location VARCHAR(200) NOT NULL DEFAULT '', notes VARCHAR(2000) NOT NULL DEFAULT '',
        income_clp BIGINT NOT NULL DEFAULT 0 CHECK (income_clp>=0), expense_clp BIGINT NOT NULL DEFAULT 0 CHECK (expense_clp>=0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS bitacora (
        id BIGSERIAL PRIMARY KEY, event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
        event_title_snapshot VARCHAR(160), cell_id SMALLINT NOT NULL CHECK (cell_id BETWEEN 1 AND 4),
        author VARCHAR(80) NOT NULL, action VARCHAR(20) NOT NULL DEFAULT 'note', message VARCHAR(3000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await pool.query('CREATE INDEX IF NOT EXISTS bitacora_created_at_idx ON bitacora (created_at DESC,id DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS bitacora_event_id_idx ON bitacora (event_id)');
      databaseReady = true;
      console.log('Shared events and activity log database ready.');
    } catch (error) { console.error('Database initialization failed:', error.message); }
  } else console.warn('DATABASE_URL is not configured; event and log endpoints are disabled.');
  app.listen(PORT, () => console.log(`Backend listo en puerto ${PORT}`));
}
start();
