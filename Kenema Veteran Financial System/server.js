/**
 * Kenema Veteran Financial Management System
 * Zero-dependency Node.js server (uses only Node built-ins).
 * Data is stored in data/db.json.
 *
 * Features:
 *  - Admin login (only Admin can create staff/user accounts)
 *  - Members: register, membership status (Active/Inactive/Suspended/Deceased)
 *  - Monthly contributions: record & track payments per member per month
 *  - Expenditures: record monthly expenses with category & notes
 *  - Dashboard: totals, monthly analysis, arrears
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ---------------------------------------------------------------------------
// Database (simple JSON file with atomic-ish writes)
// ---------------------------------------------------------------------------
let db = null;

function defaultDb() {
  return {
    users: [],            // {id, username, passwordHash, salt, role, fullName, createdAt}
    members: [],          // {id, fullName, phone, joinDate, status, monthlyDues, notes, createdAt}
    contributions: [],    // {id, memberId, amount, period(YYYY-MM), datePaid, method, recordedBy, createdAt}
    expenditures: [],     // {id, description, category, amount, dateSpent, recordedBy, createdAt}
    sessions: {},         // token -> {userId, username, role, expiresAt}
    settings: { appName: 'Kenema Veteran Financial Management System', currency: 'NLe', adminInitialized: false }
  };
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // ensure all collections exist
      const base = defaultDb();
      for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
      return;
    }
  } catch (e) {
    console.error('Failed to read database, starting fresh:', e.message);
  }
  db = defaultDb();
  ensureAdmin();
  saveDb();
}

let saveTimer = null;
let saveInProgress = false;
let savePending = false;

function saveDb() {
  savePending = true;
  if (saveTimer || saveInProgress) return;
  saveTimer = setTimeout(flushDb, 1000);
}

async function flushDb() {
  saveTimer = null;
  saveInProgress = true;
  savePending = false;
  try {
    const snapshot = JSON.stringify(db, null, 2);
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DB_FILE);
  } catch (e) {
    savePending = true;
    console.error('Failed to save database; retrying:', e.message);
  } finally {
    saveInProgress = false;
    if (savePending) saveDb();
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function newId() {
  return crypto.randomUUID();
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureAdmin() {
  if (db.users.some(u => u.role === 'admin')) return;
  const salt = newSalt();
  db.users.push({
    id: newId(),
    username: 'admin',
    fullName: 'System Administrator',
    role: 'admin',
    salt,
    passwordHash: hashPassword('admin123', salt), // MUST change after first login
    createdAt: new Date().toISOString()
  });
  db.settings.adminInitialized = true;
  console.log('Created default admin account -> username: admin, password: admin123 (change it!)');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function getSession(req) {
  const token = parseCookies(req).kvfms_session;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() > s.expiresAt) { delete db.sessions[token]; saveDb(); return null; }
  return s;
}

function requireAuth(req, res, roles) {
  const session = getSession(req);
  if (!session) { sendJson(res, 401, { error: 'Not authenticated' }); return null; }
  if (roles && !roles.includes(session.role)) { sendJson(res, 403, { error: 'Forbidden: insufficient rights' }); return null; }
  return session;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `kvfms_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'kvfms_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function isValidPeriod(p) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(p || ''); }
function isValidDate(d) { return !isNaN(Date.parse(d)); }
function toMoney(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/members/:id
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
  routes.push({ method, regex, keys, handler });
}

function listRoute(collection, filters, sort, mapItem = item => item) {
  route('GET', '/api/' + collection, async (req, res) => {
    if (!requireAuth(req, res)) return;
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    let list = db[collection].slice();
    for (const [key, predicate] of Object.entries(filters)) {
      const value = params.get(key);
      if (value) list = list.filter(item => predicate(item, value));
    }
    sendJson(res, 200, list.sort(sort).map(mapItem));
  });
}

// ---- Auth ----
route('POST', '/api/login', async (req, res) => {
  const { username, password } = await readBody(req);
  const user = db.users.find(u => u.username === String(username || '').trim().toLowerCase());
  if (!user) return sendJson(res, 401, { error: 'Invalid username or password' });
  const suppliedHash = Buffer.from(hashPassword(String(password || ''), user.salt), 'hex');
  const storedHash = Buffer.from(user.passwordHash, 'hex');
  if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
    return sendJson(res, 401, { error: 'Invalid username or password' });
  }
  const token = newToken();
  db.sessions[token] = { userId: user.id, username: user.username, role: user.role, expiresAt: Date.now() + SESSION_TTL_MS };
  saveDb();
  setSessionCookie(res, token);
  sendJson(res, 200, { user: { username: user.username, fullName: user.fullName, role: user.role } });
});

route('POST', '/api/logout', async (req, res) => {
  const token = parseCookies(req).kvfms_session;
  if (token && db.sessions[token]) { delete db.sessions[token]; saveDb(); }
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, { username: session.username, role: session.role });
});

// ---- Users (Admin only) ----
route('GET', '/api/users', async (req, res) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  sendJson(res, 200, db.users.map(u => ({ id: u.id, username: u.username, fullName: u.fullName, role: u.role, createdAt: u.createdAt })));
});

route('POST', '/api/users', async (req, res) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  const { username, password, fullName, role } = await readBody(req);
  const uname = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(uname)) return sendJson(res, 400, { error: 'Username must be 3-30 chars (letters, numbers, . _ -)' });
  if (String(password || '').length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters' });
  if (db.users.some(u => u.username === uname)) return sendJson(res, 409, { error: 'Username already exists' });
  const validRole = ['staff', 'admin'].includes(role) ? role : 'staff';
  const salt = newSalt();
  const user = { id: newId(), username: uname, fullName: String(fullName || '').trim() || uname, role: validRole, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  db.users.push(user);
  saveDb();
  sendJson(res, 201, { id: user.id, username: user.username, role: user.role });
});

route('DELETE', '/api/users/:id', async (req, res, params) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  const idx = db.users.findIndex(u => u.id === params.id);
  if (idx === -1) return sendJson(res, 404, { error: 'User not found' });
  if (db.users[idx].role === 'admin' && db.users.filter(u => u.role === 'admin').length === 1) {
    return sendJson(res, 400, { error: 'Cannot delete the only admin account' });
  }
  const removed = db.users[idx];
  db.users.splice(idx, 1);
  for (const token of Object.keys(db.sessions)) {
    if (db.sessions[token].userId === removed.id) delete db.sessions[token];
  }
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ---- Members ----
const MEMBER_STATUSES = ['Active', 'Inactive', 'Suspended', 'Deceased'];

listRoute('members', {
  status: (m, status) => m.status === status,
  q: (m, query) => {
    const search = query.toLowerCase();
    return m.fullName.toLowerCase().includes(search) || (m.phone || '').includes(search);
  }
}, (a, b) => a.fullName.localeCompare(b.fullName));

route('POST', '/api/members', async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const { fullName, phone, joinDate, status, monthlyDues, notes } = await readBody(req);
  const name = String(fullName || '').trim();
  if (name.length < 2) return sendJson(res, 400, { error: 'Full name is required' });
  const dues = toMoney(monthlyDues === '' || monthlyDues == null ? 0 : monthlyDues);
  if (dues === null) return sendJson(res, 400, { error: 'Invalid monthly dues amount' });
  if (joinDate && !isValidDate(joinDate)) return sendJson(res, 400, { error: 'Invalid join date' });
  const st = MEMBER_STATUSES.includes(status) ? status : 'Active';
  const member = {
    id: newId(), fullName: name, phone: String(phone || '').trim(),
    joinDate: joinDate || new Date().toISOString().slice(0, 10),
    status: st, monthlyDues: dues, notes: String(notes || '').trim(),
    createdAt: new Date().toISOString()
  };
  db.members.push(member);
  saveDb();
  sendJson(res, 201, member);
});

route('PUT', '/api/members/:id', async (req, res, params) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const m = db.members.find(x => x.id === params.id);
  if (!m) return sendJson(res, 404, { error: 'Member not found' });
  const body = await readBody(req);
  if (body.fullName !== undefined) {
    const name = String(body.fullName || '').trim();
    if (name.length < 2) return sendJson(res, 400, { error: 'Full name is required' });
    m.fullName = name;
  }
  if (body.phone !== undefined) m.phone = String(body.phone || '').trim();
  if (body.status !== undefined) {
    if (!MEMBER_STATUSES.includes(body.status)) return sendJson(res, 400, { error: 'Invalid status' });
    m.status = body.status;
  }
  if (body.monthlyDues !== undefined) {
    const dues = toMoney(body.monthlyDues);
    if (dues === null) return sendJson(res, 400, { error: 'Invalid monthly dues amount' });
    m.monthlyDues = dues;
  }
  if (body.notes !== undefined) m.notes = String(body.notes || '').trim();
  if (body.joinDate !== undefined) {
    if (!isValidDate(body.joinDate)) return sendJson(res, 400, { error: 'Invalid join date' });
    m.joinDate = body.joinDate;
  }
  saveDb();
  sendJson(res, 200, m);
});

route('DELETE', '/api/members/:id', async (req, res, params) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  const idx = db.members.findIndex(x => x.id === params.id);
  if (idx === -1) return sendJson(res, 404, { error: 'Member not found' });
  const id = db.members[idx].id;
  db.members.splice(idx, 1);
  db.contributions = db.contributions.filter(c => c.memberId !== id);
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ---- Contributions ----
listRoute('contributions', {
  memberId: (c, memberId) => c.memberId === memberId,
  period: (c, period) => c.period === period
}, (a, b) => (b.period || '').localeCompare(a.period || '') || (b.datePaid || '').localeCompare(a.datePaid || ''), c => {
  const m = db.members.find(x => x.id === c.memberId);
  return { ...c, memberName: m ? m.fullName : '(deleted member)' };
});

route('POST', '/api/contributions', async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const { memberId, amount, period, datePaid, method } = await readBody(req);
  const m = db.members.find(x => x.id === memberId);
  if (!m) return sendJson(res, 400, { error: 'Unknown member' });
  const amt = toMoney(amount);
  if (amt === null || amt <= 0) return sendJson(res, 400, { error: 'Amount must be a positive number' });
  if (!isValidPeriod(period)) return sendJson(res, 400, { error: 'Period must be in YYYY-MM format' });
  if (datePaid && !isValidDate(datePaid)) return sendJson(res, 400, { error: 'Invalid payment date' });
  const dup = db.contributions.find(c => c.memberId === memberId && c.period === period);
  if (dup) return sendJson(res, 409, { error: `A payment for ${m.fullName} for ${period} already exists` });
  const c = {
    id: newId(), memberId, amount: amt, period,
    datePaid: datePaid || new Date().toISOString().slice(0, 10),
    method: ['Cash', 'Mobile Money', 'Bank Transfer', 'Other'].includes(method) ? method : 'Cash',
    recordedBy: s.username, createdAt: new Date().toISOString()
  };
  db.contributions.push(c);
  saveDb();
  sendJson(res, 201, c);
});

route('DELETE', '/api/contributions/:id', async (req, res, params) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  const idx = db.contributions.findIndex(c => c.id === params.id);
  if (idx === -1) return sendJson(res, 404, { error: 'Record not found' });
  db.contributions.splice(idx, 1);
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ---- Expenditures ----
const EXP_CATEGORIES = ['Operations', 'Welfare', 'Events', 'Administrative', 'Other'];

listRoute('expenditures', {
  period: (e, period) => (e.dateSpent || '').slice(0, 7) === period
}, (a, b) => (b.dateSpent || '').localeCompare(a.dateSpent || ''));

route('POST', '/api/expenditures', async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const { description, category, amount, dateSpent } = await readBody(req);
  const desc = String(description || '').trim();
  if (desc.length < 2) return sendJson(res, 400, { error: 'Description is required' });
  const amt = toMoney(amount);
  if (amt === null || amt <= 0) return sendJson(res, 400, { error: 'Amount must be a positive number' });
  if (dateSpent && !isValidDate(dateSpent)) return sendJson(res, 400, { error: 'Invalid date' });
  const e = {
    id: newId(), description: desc,
    category: EXP_CATEGORIES.includes(category) ? category : 'Other',
    amount: amt, dateSpent: dateSpent || new Date().toISOString().slice(0, 10),
    recordedBy: s.username, createdAt: new Date().toISOString()
  };
  db.expenditures.push(e);
  saveDb();
  sendJson(res, 201, e);
});

route('DELETE', '/api/expenditures/:id', async (req, res, params) => {
  const s = requireAuth(req, res, ['admin']);
  if (!s) return;
  const idx = db.expenditures.findIndex(e => e.id === params.id);
  if (idx === -1) return sendJson(res, 404, { error: 'Record not found' });
  db.expenditures.splice(idx, 1);
  saveDb();
  sendJson(res, 200, { ok: true });
});

// ---- Dashboard / analysis ----
route('GET', '/api/dashboard', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const now = new Date();
  const thisPeriod = now.toISOString().slice(0, 7);
  const activeMembers = db.members.filter(m => m.status === 'Active');
  const expectedThisMonth = activeMembers.reduce((s, m) => s + (m.monthlyDues || 0), 0);
  const paidThisMonth = db.contributions.filter(c => c.period === thisPeriod).reduce((s, c) => s + c.amount, 0);
  const totalContributions = db.contributions.reduce((s, c) => s + c.amount, 0);
  const totalExpenditures = db.expenditures.reduce((s, e) => s + e.amount, 0);

  // last 6 months analysis
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({
      period: p,
      collected: db.contributions.filter(c => c.period === p).reduce((s, c) => s + c.amount, 0),
      spent: db.expenditures.filter(e => (e.dateSpent || '').slice(0, 7) === p).reduce((s, e) => s + e.amount, 0),
      payers: db.contributions.filter(c => c.period === p).length
    });
  }

  // arrears: active members who have NOT paid this month
  const paidIds = new Set(db.contributions.filter(c => c.period === thisPeriod).map(c => c.memberId));
  const arrears = activeMembers.filter(m => !paidIds.has(m.id))
    .map(m => ({ id: m.id, fullName: m.fullName, monthlyDues: m.monthlyDues, phone: m.phone }));

  const statusCounts = {};
  for (const st of MEMBER_STATUSES) statusCounts[st] = db.members.filter(m => m.status === st).length;

  sendJson(res, 200, {
    thisPeriod,
    totals: {
      members: db.members.length,
      activeMembers: activeMembers.length,
      expectedThisMonth, paidThisMonth, outstandingThisMonth: Math.max(0, expectedThisMonth - paidThisMonth),
      totalContributions, totalExpenditures, balance: totalContributions - totalExpenditures,
      membersInArrears: arrears.length
    },
    statusCounts,
    months,
    arrears: arrears.slice(0, 50)
  });
});

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json'
};

function serveStatic(req, res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  file = file.split('?')[0];
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = urlPath.match(r.regex);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
        await r.handler(req, res, params);
        return;
      }
    }
    if (req.method === 'GET' && !urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Internal server error' });
  }
});

loadDb();
server.listen(PORT, () => {
  console.log('==========================================================');
  console.log('  Kenema Veteran Financial Management System');
  console.log(`  Running at:  http://localhost:${PORT}`);
  console.log('  Default admin ->  username: admin   password: admin123');
  console.log('  (Change the password after first login!)');
  console.log('==========================================================');
});
