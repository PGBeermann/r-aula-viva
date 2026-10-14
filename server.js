/**
 * R Aula Viva — servidor Node.js
 * ------------------------------------------------------------------
 * Cuaderno R (webR) colaborativo en tiempo real para clases en línea.
 * El código R se ejecuta en el navegador del docente (webR/WebAssembly);
 * este servidor sólo retransmite el estado (celdas, salidas de texto,
 * gráficos PNG, foco del cursor, encuestas, preguntas, etc.) a los
 * estudiantes conectados mediante Socket.IO y lo persiste en disco.
 *
 * Variables de entorno: ver .env.example
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ─── Configuración ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const NB_DIR = path.join(DATA_DIR, 'notebooks');
const SEED_DIR = path.join(__dirname, 'seed', 'notebooks');
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || '12', 10);
const MAX_STUDENTS = parseInt(process.env.MAX_STUDENTS_PER_ROOM || '150', 10);
const WEBR_BASE_URL = process.env.WEBR_BASE_URL || '/vendor/webr/';
const WEBR_REPO_URL = process.env.WEBR_REPO_URL || 'https://repo.r-wasm.org/';
// El paquete npm trae dos compilaciones: webr.js (navegador) y webr.mjs (Node).
// El CDN oficial (https://webr.r-wasm.org/vX.Y.Z/) publica la de navegador como webr.mjs.
const WEBR_MODULE = process.env.WEBR_MODULE ||
  (WEBR_BASE_URL.startsWith('/') ? `${WEBR_BASE_URL.replace(/\/?$/, '/')}webr.js` : `${WEBR_BASE_URL.replace(/\/?$/, '/')}webr.mjs`);
const DEFAULT_PACKAGES = (process.env.DEFAULT_PACKAGES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';
const APP_VERSION = require('./package.json').version;

if (!TEACHER_PASSWORD) {
  console.warn('⚠  TEACHER_PASSWORD no está definido: el acceso docente quedará DESHABILITADO.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('⚠  SESSION_SECRET no está definido: las sesiones docentes se invalidarán al reiniciar.');
}

// Límites de seguridad
const LIM = {
  cells: 300,
  code: 100_000,          // caracteres por celda
  outLines: 4000,         // líneas de salida por celda
  outLineLen: 20_000,
  images: 12,             // gráficos por celda
  imageBytes: 3_000_000,  // tamaño de un data-URL PNG
  name: 40,
  title: 120,
  question: 600,
  submission: 20_000,
  questions: 500,
  submissions: 500,
};

for (const d of [DATA_DIR, ROOMS_DIR, NB_DIR]) fs.mkdirSync(d, { recursive: true });

// Copiar cuadernos de ejemplo la primera vez
try {
  if (fs.existsSync(SEED_DIR) && fs.readdirSync(NB_DIR).length === 0) {
    for (const f of fs.readdirSync(SEED_DIR)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(SEED_DIR, f), path.join(NB_DIR, f));
    }
  }
} catch (e) { console.warn('No se pudieron copiar los cuadernos de ejemplo:', e.message); }

// ─── Utilidades ───────────────────────────────────────────────────────────────
const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
const cleanName = v => str(v, LIM.name).replace(/[\u0000-\u001f<>]/g, '').trim();
const newId = (p = 'c') => `${p}-${crypto.randomBytes(5).toString('hex')}`;
const ROOM_CODE_RE = /^[A-Z0-9]{4,10}$/;
const CELL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const now = () => Date.now();

function genRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), b => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeCell(c) {
  if (!c || typeof c !== 'object') return null;
  const id = CELL_ID_RE.test(c.id || '') ? c.id : newId();
  return {
    id,
    type: c.type === 'markdown' ? 'markdown' : 'code',
    code: str(c.code ?? c.source ?? '', LIM.code),
    output: sanitizeOutput(c.output),
    execCount: Number.isInteger(c.execCount) ? c.execCount : null,
  };
}

function sanitizeOutput(o) {
  if (!o || typeof o !== 'object') return null;
  const lines = Array.isArray(o.lines) ? o.lines.slice(0, LIM.outLines).map(l => ({
    t: ['out', 'err', 'warn', 'msg'].includes(l?.t) ? l.t : 'out',
    d: str(l?.d, LIM.outLineLen),
  })) : [];
  const images = Array.isArray(o.images) ? o.images
    .filter(s => typeof s === 'string' && s.length <= LIM.imageBytes && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s))
    .slice(0, LIM.images) : [];
  return {
    lines, images,
    ms: Number.isFinite(o.ms) ? Math.round(o.ms) : null,
    error: !!o.error,
    at: now(),
  };
}

// ─── Autenticación docente (cookie HMAC firmada, httpOnly) ───────────────────
const COOKIE = 'rav_t';
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function makeToken() {
  const exp = now() + SESSION_HOURS * 3600_000;
  const payload = `teacher.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function verifyToken(tok) {
  if (typeof tok !== 'string') return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0, i);
  const sig = tok.slice(i + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = parseInt(payload.split('.')[1], 10);
  return Number.isFinite(exp) && exp > now();
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isTeacherReq(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}
function passwordOk(pw) {
  if (!TEACHER_PASSWORD || typeof pw !== 'string') return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(TEACHER_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Limitador simple de intentos de login por IP
const loginAttempts = new Map();
function loginLimited(ip) {
  const t = now();
  const rec = loginAttempts.get(ip) || { n: 0, reset: t + 15 * 60_000 };
  if (t > rec.reset) { rec.n = 0; rec.reset = t + 15 * 60_000; }
  rec.n++;
  loginAttempts.set(ip, rec);
  return rec.n > 10;
}

// ─── Aulas (estado en memoria + persistencia en disco) ───────────────────────
/** @type {Map<string, any>} */
const rooms = new Map();
/** participantes en vivo: code -> Map(socketId -> {clientId,name,role,hand,joinedAt}) */
const live = new Map();
const saveTimers = new Map();

function blankRoom(title) {
  return {
    code: genRoomCode(),
    title: str(title, LIM.title) || 'Clase de R',
    createdAt: now(),
    updatedAt: now(),
    cells: [{ id: newId(), type: 'markdown', code: '# Bienvenidos\nEscriba aquí los objetivos de la clase.', output: null, execCount: null },
            { id: newId(), type: 'code', code: 'summary(mtcars$mpg)\nhist(mtcars$mpg, col = "steelblue", main = "Consumo (mpg)")', output: null, execCount: null }],
    execCounter: 0,
    packages: [...DEFAULT_PACKAGES],
    settings: { allowDownload: true, allowQuestions: true, allowSubmissions: true, allowLocalRun: true },
    focus: null,
    announce: null,
    timer: null,
    poll: null,
    questions: [],
    submissions: [],
  };
}

function loadRooms() {
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
      if (r && ROOM_CODE_RE.test(r.code)) {
        r.cells = (r.cells || []).map(sanitizeCell).filter(Boolean);
        r.settings = { ...blankRoom().settings, ...(r.settings || {}) };
        r.questions ||= []; r.submissions ||= []; r.packages ||= [];
        r.focus = null; r.timer = null;
        rooms.set(r.code, r);
      }
    } catch (e) { console.warn(`Aula corrupta ${f}:`, e.message); }
  }
  console.log(`Aulas cargadas: ${rooms.size}`);
}

function scheduleSave(room) {
  room.updatedAt = now();
  if (saveTimers.has(room.code)) return;
  saveTimers.set(room.code, setTimeout(() => saveRoom(room.code), 1500));
}
async function saveRoom(code) {
  clearTimeout(saveTimers.get(code));
  saveTimers.delete(code);
  const room = rooms.get(code);
  if (!room) return;
  const file = path.join(ROOMS_DIR, `${code}.json`);
  const tmp = `${file}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(room));
    await fsp.rename(tmp, file);
  } catch (e) { console.error('Error guardando aula', code, e.message); }
}

function roomSummary(r) {
  const p = live.get(r.code);
  const students = p ? [...p.values()].filter(x => x.role === 'student') : [];
  return {
    code: r.code, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
    cells: r.cells.length, online: new Set(students.map(s => s.clientId)).size,
  };
}

// Vista del estado para cada rol
function publicState(room, role, clientId) {
  const base = {
    code: room.code, title: room.title, cells: room.cells, focus: room.focus,
    packages: room.packages, settings: room.settings, announce: room.announce,
    timer: room.timer ? { ...room.timer, serverNow: now() } : null, execCounter: room.execCounter,
    webr: { baseUrl: WEBR_BASE_URL, repoUrl: WEBR_REPO_URL, module: WEBR_MODULE },
  };
  if (role === 'teacher') {
    return { ...base, poll: room.poll, questions: room.questions, submissions: room.submissions };
  }
  return {
    ...base,
    poll: pollForStudent(room.poll, clientId),
    questions: room.questions.filter(q => q.clientId === clientId).map(stripQ),
  };
}
const stripQ = q => ({ id: q.id, text: q.text, at: q.at, resolved: q.resolved, answer: q.answer || null });

function pollForStudent(poll, clientId) {
  if (!poll) return null;
  const out = { id: poll.id, question: poll.question, options: poll.options, open: poll.open,
                myVote: poll.votes[clientId] ?? null };
  if (!poll.open || poll.showResults) out.results = pollResults(poll);
  return out;
}
function pollResults(poll) {
  const counts = poll.options.map(() => 0);
  for (const v of Object.values(poll.votes)) if (counts[v] !== undefined) counts[v]++;
  return { counts, total: Object.keys(poll.votes).length };
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás de Traefik (Dokploy)

app.use((req, res, next) => {
  // COOP/COEP: habilitan crossOriginIsolated → SharedArrayBuffer para webR
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '8mb' }));

// Librerías del cliente servidas localmente (sin depender de CDNs)
const nm = p => path.join(__dirname, 'node_modules', p);
const vendorOpts = { maxAge: IS_PROD ? '7d' : 0, immutable: IS_PROD };
app.use('/vendor/codemirror', express.static(nm('codemirror'), vendorOpts));
app.use('/vendor/katex', express.static(nm('katex/dist'), vendorOpts));
app.use('/vendor/marked', express.static(nm('marked/lib'), vendorOpts));
app.use('/vendor/dompurify', express.static(nm('dompurify/dist'), vendorOpts));
app.use('/vendor/lucide', express.static(nm('lucide/dist/umd'), vendorOpts));
app.use('/vendor/webr', express.static(nm('webr/dist'), {
  ...vendorOpts,
  setHeaders: (res, file) => { if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm'); },
}));
// HTML, JS y CSS propios: el navegador debe revalidar siempre (ETag) para que cada
// despliegue se vea de inmediato, sin necesidad de borrar la caché.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

const requireTeacher = (req, res, next) =>
  isTeacherReq(req) ? next() : res.status(401).json({ ok: false, error: 'Se requiere sesión docente.' });

app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION, rooms: rooms.size, uptime: Math.round(process.uptime()) }));

const noCache = { headers: { 'Cache-Control': 'no-cache' } };
// Los archivos JS/CSS del aula se sirven bajo /v/<versión>/… : tras cada despliegue cambia la
// dirección, de modo que ningún navegador puede seguir usando una copia antigua en caché.
app.use('/v/:ver', (req, res, next) => (req.params.ver === APP_VERSION ? next() : res.redirect(302, `/v/${APP_VERSION}${req.path}`)),
  express.static(path.join(__dirname, 'public'), { index: false, maxAge: '30d', immutable: true }));
const AULA_HTML = fs.readFileSync(path.join(__dirname, 'public', 'aula.html'), 'utf8')
  .replace('src="/js/aula.js"', `src="/v/${APP_VERSION}/js/aula.js"`)
  .replace('href="/css/app.css"', `href="/v/${APP_VERSION}/css/app.css"`);
app.get('/docente', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docente.html'), noCache));
app.get('/aula/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!ROOM_CODE_RE.test(code)) return res.redirect('/');
  res.set('Cache-Control', 'no-cache').type('html').send(AULA_HTML);
});

// Sesión docente
app.post('/api/login', (req, res) => {
  if (!TEACHER_PASSWORD) return res.status(503).json({ ok: false, error: 'Acceso docente no configurado (TEACHER_PASSWORD).' });
  if (loginLimited(req.ip)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espere 15 minutos.' });
  if (!passwordOk(req.body?.password)) return res.status(401).json({ ok: false, error: 'Contraseña incorrecta.' });
  loginAttempts.delete(req.ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ teacher: isTeacherReq(req), teacherEnabled: !!TEACHER_PASSWORD, version: APP_VERSION }));

// Aulas
app.get('/api/rooms', requireTeacher, (req, res) => {
  res.json({ ok: true, rooms: [...rooms.values()].map(roomSummary).sort((a, b) => b.updatedAt - a.updatedAt) });
});
app.post('/api/rooms', requireTeacher, async (req, res) => {
  const room = blankRoom(req.body?.title);
  rooms.set(room.code, room);
  await saveRoom(room.code);
  res.status(201).json({ ok: true, room: roomSummary(room) });
});
app.patch('/api/rooms/:code', requireTeacher, (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: 'Aula no encontrada.' });
  if (typeof req.body?.title === 'string') room.title = str(req.body.title, LIM.title) || room.title;
  scheduleSave(room);
  io.to(room.code).emit('room:title', room.title);
  res.json({ ok: true, room: roomSummary(room) });
});
app.delete('/api/rooms/:code', requireTeacher, async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!rooms.has(code)) return res.status(404).json({ ok: false, error: 'Aula no encontrada.' });
  io.to(code).emit('room:closed');
  io.in(code).disconnectSockets(true);
  rooms.delete(code);
  live.delete(code);
  clearTimeout(saveTimers.get(code)); saveTimers.delete(code);
  await fsp.rm(path.join(ROOMS_DIR, `${code}.json`), { force: true });
  res.json({ ok: true });
});
app.get('/api/rooms/:code/exists', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ ok: false, error: 'No existe un aula con ese código.' });
  res.json({ ok: true, code: room.code, title: room.title });
});
app.get('/api/rooms/:code/qr.svg', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!rooms.has(code)) return res.status(404).end();
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const svg = await QRCode.toString(`${base}/aula/${code}`, { type: 'svg', margin: 1, width: 320 });
  res.type('image/svg+xml').send(svg);
});
// Exportar el estado completo de un aula (incluye salidas e imágenes)
app.get('/api/rooms/:code/export.json', requireTeacher, (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="aula_${room.code}.json"`);
  res.json({ version: 2, title: room.title, savedAt: new Date().toISOString(), cells: room.cells });
});

// Biblioteca de cuadernos (reemplaza upload.php)
const NB_FILE_RE = /^[A-Za-z0-9_.-]{1,80}\.json$/;
const slug = s => str(s, 60).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'cuaderno';

app.get('/api/notebooks', requireTeacher, async (req, res) => {
  const files = (await fsp.readdir(NB_DIR)).filter(f => NB_FILE_RE.test(f));
  const list = await Promise.all(files.map(async f => {
    const st = await fsp.stat(path.join(NB_DIR, f));
    let title = f.replace(/\.json$/, ''), cells = null;
    try { const j = JSON.parse(await fsp.readFile(path.join(NB_DIR, f), 'utf8')); title = j.title || title; cells = (j.cells || []).length; } catch {}
    return { file: f, title, cells, size: st.size, modified: st.mtimeMs };
  }));
  res.json({ ok: true, notebooks: list.sort((a, b) => b.modified - a.modified) });
});
app.get('/api/notebooks/:file', requireTeacher, async (req, res) => {
  const f = req.params.file;
  if (!NB_FILE_RE.test(f)) return res.status(400).json({ ok: false, error: 'Nombre inválido.' });
  try { res.type('application/json').send(await fsp.readFile(path.join(NB_DIR, f), 'utf8')); }
  catch { res.status(404).json({ ok: false, error: 'No encontrado.' }); }
});
app.post('/api/notebooks', requireTeacher, async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.cells)) return res.status(422).json({ ok: false, error: 'Falta el arreglo "cells".' });
  const cells = b.cells.slice(0, LIM.cells).map(sanitizeCell).filter(Boolean)
    .map(c => (b.withOutputs ? c : { ...c, output: null, execCount: null }));
  const title = str(b.title, LIM.title) || 'Cuaderno';
  const file = `${slug(b.file ? b.file.replace(/\.json$/, '') : title)}.json`;
  await fsp.writeFile(path.join(NB_DIR, file), JSON.stringify({ version: 2, title, savedAt: new Date().toISOString(), cells }, null, 2));
  res.status(201).json({ ok: true, file, cells: cells.length });
});
app.delete('/api/notebooks/:file', requireTeacher, async (req, res) => {
  const f = req.params.file;
  if (!NB_FILE_RE.test(f)) return res.status(400).json({ ok: false, error: 'Nombre inválido.' });
  await fsp.rm(path.join(NB_DIR, f), { force: true });
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, error: err.type === 'entity.too.large' ? 'Contenido demasiado grande.' : 'Error interno.' });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 12e6,          // salidas con varios gráficos PNG
  pingInterval: 20000,
  pingTimeout: 25000,
  cors: { origin: false },          // sólo mismo origen
});

io.use((socket, next) => {
  const a = socket.handshake.auth || {};
  const code = String(a.room || '').toUpperCase();
  if (!ROOM_CODE_RE.test(code) || !rooms.has(code)) return next(new Error('AULA_NO_EXISTE'));
  const wantsTeacher = a.role === 'teacher';
  const teacher = wantsTeacher && verifyToken(parseCookies(socket.handshake.headers.cookie)[COOKIE]);
  if (wantsTeacher && !teacher) return next(new Error('NO_AUTORIZADO'));
  const name = teacher ? (cleanName(a.name) || 'Docente') : cleanName(a.name);
  if (!name) return next(new Error('NOMBRE_REQUERIDO'));
  const clientId = /^[A-Za-z0-9-]{8,64}$/.test(a.clientId || '') ? a.clientId : crypto.randomUUID();
  if (!teacher) {
    const p = live.get(code);
    const n = p ? new Set([...p.values()].filter(x => x.role === 'student').map(x => x.clientId)).size : 0;
    if (n >= MAX_STUDENTS) return next(new Error('AULA_LLENA'));
  }
  socket.data = { code, role: teacher ? 'teacher' : 'student', name, clientId, bucket: { t: now(), n: 0 } };
  next();
});

// Limitador de eventos por socket (anti-spam de estudiantes)
function rateOk(socket, max = 20, windowMs = 10_000) {
  const b = socket.data.bucket;
  const t = now();
  if (t - b.t > windowMs) { b.t = t; b.n = 0; }
  return ++b.n <= max;
}

function participantsList(code) {
  const p = live.get(code);
  if (!p) return [];
  const byClient = new Map();
  for (const x of p.values()) {
    const prev = byClient.get(x.clientId);
    if (!prev) byClient.set(x.clientId, { ...x, tabs: 1 });
    else { prev.tabs++; prev.hand = prev.hand || x.hand; }
  }
  return [...byClient.values()].map(x => ({
    clientId: x.clientId, name: x.name, role: x.role, hand: x.hand, joinedAt: x.joinedAt, tabs: x.tabs,
  })).sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.hand && b.hand ? a.hand - b.hand : a.name.localeCompare(b.name)));
}
function broadcastParticipants(code) {
  const list = participantsList(code);
  io.to(`${code}:teacher`).emit('participants', list);
  io.to(`${code}:student`).emit('participants:count', list.filter(x => x.role === 'student').length);
}
const toTeachers = (code, ev, data) => io.to(`${code}:teacher`).emit(ev, data);

io.on('connection', socket => {
  const { code, role, name, clientId } = socket.data;
  const room = rooms.get(code);
  if (!room) return socket.disconnect(true);

  socket.join(code);
  socket.join(`${code}:${role}`);
  socket.join(`${code}:c:${clientId}`);
  if (!live.has(code)) live.set(code, new Map());
  live.get(code).set(socket.id, { clientId, name, role, hand: null, joinedAt: now() });

  socket.emit('state', { ...publicState(room, role, clientId), me: { role, name, clientId } });
  broadcastParticipants(code);

  const isT = role === 'teacher';
  const getCell = id => room.cells.find(c => c.id === id);
  const emitOthers = (ev, data) => socket.to(code).emit(ev, data);

  // Envoltura: ignora eventos de docente enviados por estudiantes y captura errores
  const onT = (ev, fn) => socket.on(ev, (...args) => {
    if (!isT) return;
    try { fn(...args); } catch (e) { console.error(`[${ev}]`, e); }
  });
  const onS = (ev, fn, max) => socket.on(ev, (...args) => {
    if (!rateOk(socket, max)) return;
    try { fn(...args); } catch (e) { console.error(`[${ev}]`, e); }
  });

  // ── Docente: edición del cuaderno ──
  onT('cell:add', ({ afterId, cell } = {}) => {
    if (room.cells.length >= LIM.cells) return;
    const c = sanitizeCell(cell);
    if (!c || getCell(c.id)) return;
    const idx = afterId ? room.cells.findIndex(x => x.id === afterId) : -1;
    if (afterId === '__top__') room.cells.unshift(c);
    else if (idx >= 0) room.cells.splice(idx + 1, 0, c);
    else room.cells.push(c);
    emitOthers('cell:add', { afterId, cell: c });
    scheduleSave(room);
  });
  onT('cell:update', ({ id, code: src } = {}) => {
    const c = getCell(id);
    if (!c || typeof src !== 'string') return;
    c.code = str(src, LIM.code);
    emitOthers('cell:update', { id, code: c.code });
    scheduleSave(room);
  });
  onT('cell:type', ({ id, type } = {}) => {
    const c = getCell(id);
    if (!c) return;
    c.type = type === 'markdown' ? 'markdown' : 'code';
    c.output = null;
    emitOthers('cell:type', { id, type: c.type });
    scheduleSave(room);
  });
  onT('cell:delete', ({ id } = {}) => {
    const i = room.cells.findIndex(c => c.id === id);
    if (i < 0) return;
    room.cells.splice(i, 1);
    emitOthers('cell:delete', { id });
    scheduleSave(room);
  });
  onT('cell:move', ({ id, dir } = {}) => {
    const i = room.cells.findIndex(c => c.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= room.cells.length) return;
    [room.cells[i], room.cells[j]] = [room.cells[j], room.cells[i]];
    emitOthers('cell:move', { id, dir });
    scheduleSave(room);
  });
  onT('cell:running', ({ id } = {}) => {
    if (getCell(id)) emitOthers('cell:running', { id });
  });
  onT('cell:output', ({ id, output } = {}) => {
    const c = getCell(id);
    if (!c) return;
    c.output = sanitizeOutput(output);
    c.execCount = ++room.execCounter;
    io.to(code).emit('cell:output', { id, output: c.output, execCount: c.execCount });
    scheduleSave(room);
  });
  onT('cells:clearOutputs', () => {
    room.cells.forEach(c => { c.output = null; c.execCount = null; });
    room.execCounter = 0;
    emitOthers('cells:clearOutputs');
    scheduleSave(room);
  });
  onT('notebook:replace', ({ cells, title } = {}) => {
    if (!Array.isArray(cells)) return;
    room.cells = cells.slice(0, LIM.cells).map(sanitizeCell).filter(Boolean);
    if (typeof title === 'string' && title.trim()) room.title = str(title, LIM.title);
    room.execCounter = 0;
    room.focus = null;
    io.to(code).emit('notebook:replace', { cells: room.cells, title: room.title });
    scheduleSave(room);
  });
  onT('focus', f => {
    if (!f || !getCell(f.id)) return;
    const pos = p => (p && Number.isInteger(p.line) && Number.isInteger(p.ch) ? { line: p.line, ch: p.ch } : null);
    room.focus = { id: f.id, from: pos(f.from), to: pos(f.to), scroll: !!f.scroll };
    emitOthers('focus', room.focus);
  });
  onT('packages', list => {
    if (!Array.isArray(list)) return;
    room.packages = [...new Set(list.map(p => str(p, 60).trim()).filter(p => /^[A-Za-z][A-Za-z0-9.]*$/.test(p)))].slice(0, 60);
    io.to(code).emit('packages', room.packages);
    scheduleSave(room);
  });
  onT('settings', s => {
    if (!s || typeof s !== 'object') return;
    for (const k of Object.keys(room.settings)) if (typeof s[k] === 'boolean') room.settings[k] = s[k];
    io.to(code).emit('settings', room.settings);
    scheduleSave(room);
  });
  onT('announce', a => {
    room.announce = a && typeof a.text === 'string' && a.text.trim()
      ? { text: str(a.text, 400), level: ['info', 'warn', 'ok'].includes(a.level) ? a.level : 'info', at: now() }
      : null;
    io.to(code).emit('announce', room.announce);
    scheduleSave(room);
  });
  onT('timer', t => {
    const secs = Number(t?.seconds);
    room.timer = Number.isFinite(secs) && secs > 0
      ? { endsAt: now() + Math.min(secs, 4 * 3600) * 1000, label: str(t.label, 80), serverNow: now() }
      : null;
    io.to(code).emit('timer', room.timer);
  });
  onT('hands:lower', ({ clientId: cid } = {}) => {
    for (const x of live.get(code)?.values() || []) if (!cid || x.clientId === cid) x.hand = null;
    if (cid) io.to(`${code}:c:${cid}`).emit('hand', null);
    else io.to(`${code}:student`).emit('hand', null);
    broadcastParticipants(code);
  });

  // ── Encuestas ──
  onT('poll:start', p => {
    const question = str(p?.question, 300).trim();
    const options = Array.isArray(p?.options) ? p.options.map(o => str(o, 120).trim()).filter(Boolean).slice(0, 8) : [];
    if (!question || options.length < 2) return;
    room.poll = { id: newId('p'), question, options, open: true, showResults: !!p.showResults, votes: {}, at: now() };
    for (const s of io.sockets.adapter.rooms.get(`${code}:student`) || []) {
      const so = io.sockets.sockets.get(s);
      so?.emit('poll', pollForStudent(room.poll, so.data.clientId));
    }
    toTeachers(code, 'poll', { ...room.poll, results: pollResults(room.poll) });
  });
  onT('poll:end', () => {
    if (!room.poll) return;
    room.poll.open = false;
    // reenviar a cada estudiante los resultados junto con su propio voto
    for (const s of io.sockets.adapter.rooms.get(`${code}:student`) || []) {
      const so = io.sockets.sockets.get(s);
      so?.emit('poll', pollForStudent(room.poll, so.data.clientId));
    }
    toTeachers(code, 'poll', { ...room.poll, results: pollResults(room.poll) });
    scheduleSave(room);
  });
  onT('poll:clear', () => {
    room.poll = null;
    io.to(code).emit('poll', null);
    scheduleSave(room);
  });
  onS('poll:vote', ({ id, option } = {}) => {
    const poll = room.poll;
    if (isT || !poll || !poll.open || poll.id !== id) return;
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) return;
    poll.votes[clientId] = option;
    io.to(`${code}:c:${clientId}`).emit('poll', pollForStudent(poll, clientId));
    toTeachers(code, 'poll', { ...poll, results: pollResults(poll) });
    if (poll.showResults) {
      for (const s of io.sockets.adapter.rooms.get(`${code}:student`) || []) {
        const so = io.sockets.sockets.get(s);
        if (so && so.data.clientId !== clientId) so.emit('poll', pollForStudent(poll, so.data.clientId));
      }
    }
  });

  // ── Mano levantada ──
  onS('hand', raised => {
    if (isT) return;
    const me = live.get(code)?.get(socket.id);
    if (!me) return;
    const val = raised ? now() : null;
    for (const x of live.get(code).values()) if (x.clientId === clientId) x.hand = val;
    io.to(`${code}:c:${clientId}`).emit('hand', val);
    broadcastParticipants(code);
  });

  // ── Preguntas ──
  onS('question', text => {
    if (isT || !room.settings.allowQuestions) return;
    const t = str(text, LIM.question).trim();
    if (!t) return;
    const q = { id: newId('q'), clientId, name, text: t, at: now(), resolved: false, answer: null };
    room.questions.push(q);
    if (room.questions.length > LIM.questions) room.questions.shift();
    toTeachers(code, 'question:new', q);
    io.to(`${code}:c:${clientId}`).emit('question:mine', stripQ(q));
    scheduleSave(room);
  }, 6);
  onT('question:resolve', ({ id, answer, resolved = true } = {}) => {
    const q = room.questions.find(x => x.id === id);
    if (!q) return;
    q.resolved = !!resolved;
    if (typeof answer === 'string') q.answer = str(answer, LIM.question).trim() || null;
    toTeachers(code, 'question:update', q);
    io.to(`${code}:c:${q.clientId}`).emit('question:mine', stripQ(q));
    scheduleSave(room);
  });
  onT('questions:clear', () => {
    room.questions = [];
    toTeachers(code, 'questions', []);
    scheduleSave(room);
  });

  // ── Entregas de código ──
  onS('submit', s => {
    if (isT || !room.settings.allowSubmissions) return;
    const codeTxt = str(s?.code, LIM.submission);
    if (!codeTxt.trim()) return;
    const sub = {
      id: newId('s'), clientId, name, code: codeTxt, note: str(s?.note, 300),
      outputText: str(s?.outputText, 8000), at: now(), reviewed: false,
    };
    room.submissions.push(sub);
    if (room.submissions.length > LIM.submissions) room.submissions.shift();
    toTeachers(code, 'submission:new', sub);
    socket.emit('submit:ok', { id: sub.id, at: sub.at });
    scheduleSave(room);
  }, 6);
  onT('submission:reviewed', ({ id, reviewed = true } = {}) => {
    const s = room.submissions.find(x => x.id === id);
    if (!s) return;
    s.reviewed = !!reviewed;
    toTeachers(code, 'submission:update', s);
    scheduleSave(room);
  });
  onT('submissions:clear', () => {
    room.submissions = [];
    toTeachers(code, 'submissions', []);
    scheduleSave(room);
  });

  // ── Reacciones rápidas (emoji) ──
  onS('react', emoji => {
    if (isT) return;
    const allowed = ['👍', '👏', '🤔', '😕', '🐢', '🚀'];
    if (!allowed.includes(emoji)) return;
    toTeachers(code, 'react', { emoji, name });
  }, 10);

  socket.on('disconnect', () => {
    live.get(code)?.delete(socket.id);
    if (live.get(code)?.size === 0) live.delete(code);
    broadcastParticipants(code);
  });
});

// ─── Arranque y apagado ordenado ──────────────────────────────────────────────
loadRooms();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`R Aula Viva v${APP_VERSION} escuchando en http://0.0.0.0:${PORT}`);
  console.log(`Datos en ${DATA_DIR} · webR desde ${WEBR_BASE_URL}`);
});

async function shutdown(sig) {
  console.log(`${sig} recibido: guardando aulas…`);
  await Promise.all([...rooms.keys()].map(saveRoom));
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
