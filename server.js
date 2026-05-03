'use strict';
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Team definitions ──────────────────────────────────────────────────────────
const TEAMS = {
  alpha: { label: "David's Team" },
  beta:  { label: "Noa's Team"   },
};

// ── JSON file storage ─────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'db.json');

const DEFAULT_DB = {
  appointments:  [],
  contacts:      [],
  callLogs:      [],
  prospectNotes: [],
  activityLog:   [],
  users: [
    { id: 1, username: 'admin',   password: 'admin123', role: 'admin', name: 'Administrator', team: null    },
    { id: 2, username: 'david',   password: 'agent123', role: 'agent', name: 'David Cohen',   team: 'alpha' },
    { id: 3, username: 'sarah',   password: 'agent123', role: 'agent', name: 'Sarah Levi',    team: 'alpha' },
    { id: 4, username: 'michael', password: 'agent123', role: 'agent', name: 'Michael Roth',  team: 'beta'  },
    { id: 5, username: 'noa',     password: 'agent123', role: 'agent', name: 'Noa Shapiro',   team: 'beta'  },
  ],
  _seq: { appointments: 0, contacts: 0, callLogs: 0, prospectNotes: 0, activityLog: 0, users: 5 },
};

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  // patch missing team fields
  const teamMap = { admin: null, david: 'alpha', sarah: 'alpha', michael: 'beta', noa: 'beta' };
  db.users = db.users.map(u => u.team !== undefined ? u : { ...u, team: teamMap[u.username] ?? null });
  return db;
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function nextId(db, col) {
  db._seq[col] = (db._seq[col] || 0) + 1;
  return db._seq[col];
}

function now() { return new Date().toISOString(); }

function logActivity(db, type, description, referenceId = null) {
  const id = nextId(db, 'activityLog');
  db.activityLog.unshift({ id, type, description, referenceId, createdAt: now() });
}

// ── Sessions (in-memory) ──────────────────────────────────────────────────────
const sessions = new Map();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getToken(req) {
  return req.headers['x-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
}
function requireAuth(req, res, next) {
  const s = sessions.get(getToken(req));
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  req.user = s; next();
}
function requireAdmin(req, res, next) {
  const s = sessions.get(getToken(req));
  if (!s)                 return res.status(401).json({ error: 'Unauthorized' });
  if (s.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  req.user = s; next();
}
function visibleAppts(list, user) {
  return user.role === 'admin' ? list : list.filter(a => a.createdBy === user.username);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db   = readDB();
  const user = db.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, role: user.role, name: user.name, team: user.team || null });
  logActivity(db, 'auth.login', `${user.name} logged in`, user.id);
  writeDB(db);
  res.json({ token, role: user.role, name: user.name, username: user.username, team: user.team || null });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/logout', requireAuth, (req, res) => {
  const db = readDB();
  logActivity(db, 'auth.logout', `${req.user.name} logged out`, req.user.userId);
  writeDB(db);
  sessions.delete(getToken(req));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: now() }));

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const db = readDB();
  const ap = db.appointments;
  res.json({
    total:     ap.length,
    pending:   ap.filter(a => a.status === 'pending').length,
    confirmed: ap.filter(a => a.status === 'confirmed').length,
    followup:  ap.filter(a => a.status === 'followup').length,
    cancelled: ap.filter(a => a.status === 'cancelled').length,
    calls:     db.callLogs.length,
    contacts:  db.contacts.length,
  });
});

// ── Appointments ──────────────────────────────────────────────────────────────
app.get('/api/appointments', requireAuth, (req, res) => {
  const db  = readDB();
  const all = [...db.appointments].sort((a, b) => (a.date > b.date ? 1 : -1));
  res.json(visibleAppts(all, req.user));
});

app.get('/api/appointments/:id', requireAuth, (req, res) => {
  const db   = readDB();
  const id   = Number(req.params.id);
  const appt = visibleAppts(db.appointments, req.user).find(a => a.id === id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  const notes = db.prospectNotes.filter(n => n.appointmentId === id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ...appt, notes });
});

app.post('/api/appointments', requireAuth, (req, res) => {
  const { firstName, lastName, phone, email, policyType, date, agent, meetingType, notes } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'firstName and lastName required' });
  const db   = readDB();
  const id   = nextId(db, 'appointments');
  const appt = { id, firstName, lastName, phone, email, policyType, date, agent, meetingType, notes,
                 status: 'pending', createdBy: req.user.username, createdAt: now(), updatedAt: now() };
  db.appointments.push(appt);
  logActivity(db, 'appointment.created', `${firstName} ${lastName} — ${policyType} (by ${req.user.name})`, id);
  writeDB(db);
  res.status(201).json(appt);
});

app.put('/api/appointments/:id', requireAuth, (req, res) => {
  const db   = readDB();
  const id   = Number(req.params.id);
  const appt = visibleAppts(db.appointments, req.user).find(a => a.id === id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  const allowed = ['firstName','lastName','phone','email','policyType','date','agent','meetingType','notes','status'];
  allowed.forEach(k => { if (req.body[k] !== undefined) appt[k] = req.body[k]; });
  appt.updatedAt = now();
  if (req.body.status) logActivity(db, 'appointment.status',
    `${appt.firstName} ${appt.lastName} → ${req.body.status} (by ${req.user.name})`, id);
  writeDB(db);
  res.json(appt);
});

app.delete('/api/appointments/:id', requireAuth, (req, res) => {
  const db   = readDB();
  const id   = Number(req.params.id);
  const appt = visibleAppts(db.appointments, req.user).find(a => a.id === id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  logActivity(db, 'appointment.deleted', `${appt.firstName} ${appt.lastName} (by ${req.user.name})`, id);
  db.appointments = db.appointments.filter(a => a.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// ── Prospect Notes ────────────────────────────────────────────────────────────
app.get('/api/appointments/:id/notes', requireAuth, (req, res) => {
  const db = readDB();
  res.json(db.prospectNotes.filter(n => n.appointmentId === Number(req.params.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/appointments/:id/notes', requireAuth, (req, res) => {
  const { content, type = 'note' } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const db   = readDB();
  const id   = nextId(db, 'prospectNotes');
  const note = { id, appointmentId: Number(req.params.id), content, type, author: req.user.name, createdAt: now() };
  db.prospectNotes.push(note);
  logActivity(db, 'note.added', `${content.slice(0, 60)} (by ${req.user.name})`, id);
  writeDB(db);
  res.status(201).json(note);
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const db = readDB();
  db.prospectNotes = db.prospectNotes.filter(n => n.id !== Number(req.params.id));
  writeDB(db);
  res.json({ ok: true });
});

// ── Call Logs ─────────────────────────────────────────────────────────────────
app.get('/api/call-logs', requireAuth, (req, res) => {
  const db = readDB();
  res.json([...db.callLogs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50));
});

app.post('/api/call-logs', requireAuth, (req, res) => {
  const { number, contactName, via, appointmentId } = req.body;
  const db  = readDB();
  const id  = nextId(db, 'callLogs');
  const log = { id, number, contactName, via, appointmentId: appointmentId || null,
                agent: req.user.name, createdAt: now() };
  db.callLogs.push(log);
  logActivity(db, 'call.made', `${contactName || number} via ${via} (by ${req.user.name})`, id);
  writeDB(db);
  res.status(201).json(log);
});

app.delete('/api/call-logs', requireAdmin, (req, res) => {
  const db = readDB();
  db.callLogs = [];
  writeDB(db);
  res.json({ ok: true });
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/api/contacts', requireAuth, (req, res) => {
  const db = readDB();
  res.json([...db.contacts].sort((a, b) => (a.lastName > b.lastName ? 1 : -1)));
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const { firstName, lastName, phone, email, address, source, tags } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'firstName and lastName required' });
  const db      = readDB();
  const id      = nextId(db, 'contacts');
  const contact = { id, firstName, lastName, phone, email, address, source,
                    tags: tags || [], createdAt: now(), updatedAt: now() };
  db.contacts.push(contact);
  logActivity(db, 'contact.created', `${firstName} ${lastName} (by ${req.user.name})`, id);
  writeDB(db);
  res.status(201).json(contact);
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  const db = readDB();
  db.contacts = db.contacts.filter(c => c.id !== Number(req.params.id));
  writeDB(db);
  res.json({ ok: true });
});

// ── Activity Log (admin only) ─────────────────────────────────────────────────
app.get('/api/activity', requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.activityLog.slice(0, 100));
});

app.delete('/api/activity', requireAdmin, (req, res) => {
  const db = readDB();
  db.activityLog = [];
  writeDB(db);
  res.json({ ok: true });
});

// ── Users (admin only) ────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const db = readDB();
  res.json(db.users.map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, team: u.team })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, name } = req.body;
  if (!username || !password || !role || !name) return res.status(400).json({ error: 'All fields required' });
  const db = readDB();
  if (db.users.find(u => u.username === username)) return res.status(409).json({ error: 'Username already exists' });
  const id   = nextId(db, 'users');
  const user = { id, username, password, role, name, team: null };
  db.users.push(user);
  logActivity(db, 'user.created', `New ${role}: ${name}`, id);
  writeDB(db);
  res.status(201).json({ id: user.id, username: user.username, role: user.role, name: user.name, team: user.team });
});

app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const db   = readDB();
  const id   = Number(req.params.id);
  const user = db.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.password = password;
  logActivity(db, 'user.password_changed', `Password changed for ${user.name}`, id);
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Cannot delete the admin account' });
  const db = readDB();
  db.users = db.users.filter(u => u.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', requireAuth, (req, res) => {
  const db       = readDB();
  let calls      = db.callLogs;
  const allAppts = db.appointments;
  const allUsers = db.users;
  const n        = new Date();

  if (req.user.role !== 'admin') {
    if (req.query.scope === 'company') {
      // no filter
    } else if (req.query.scope === 'team' && req.user.team) {
      const teamNames = allUsers.filter(u => u.team === req.user.team).map(u => u.name);
      calls = calls.filter(c => teamNames.includes(c.agent));
    } else {
      calls = calls.filter(c => c.agent === req.user.name);
    }
  } else if (req.query.agent) {
    const target = allUsers.find(u => u.username === req.query.agent);
    if (target) calls = calls.filter(c => c.agent === target.name);
  }

  const perProspect = allAppts.map(a => {
    const fullName = `${a.firstName} ${a.lastName}`;
    const dials    = calls.filter(c =>
      c.appointmentId === a.id || (!c.appointmentId && c.contactName === fullName)
    ).length;
    return { id: a.id, name: fullName, status: a.status, policyType: a.policyType, dials, agent: a.agent || '' };
  }).filter(p => p.dials > 0).sort((a, b) => b.dials - a.dials);

  const dialsToConfirm = perProspect
    .filter(p => p.status === 'confirmed')
    .map(p => ({ name: p.name, dials: p.dials, agent: p.agent }))
    .sort((a, b) => a.dials - b.dials);

  function bucket(s, e) {
    return calls.filter(c => { const t = new Date(c.createdAt); return t >= s && t < e; }).length;
  }

  const dayData = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(n); d.setDate(d.getDate() - (29 - i)); d.setHours(0,0,0,0);
    const nxt = new Date(d); nxt.setDate(d.getDate() + 1);
    return { label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), count: bucket(d, nxt) };
  });
  const weekData = Array.from({ length: 12 }, (_, i) => {
    const s = new Date(n); s.setDate(s.getDate() - s.getDay() - (11 - i) * 7); s.setHours(0,0,0,0);
    const e = new Date(s); e.setDate(s.getDate() + 7);
    return { label: s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), count: bucket(s, e) };
  });
  const monthData = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(n.getFullYear(), n.getMonth() - (11 - i), 1);
    const nxt = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return { label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), count: bucket(d, nxt) };
  });
  const yearData = Array.from({ length: 5 }, (_, i) => {
    const y = n.getFullYear() - (4 - i);
    return { label: String(y), count: bucket(new Date(y, 0, 1), new Date(y + 1, 0, 1)) };
  });

  const todayStart = new Date(n); todayStart.setHours(0,0,0,0);
  const weekStart  = new Date(n); weekStart.setDate(n.getDate() - n.getDay()); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(n.getFullYear(), n.getMonth(), 1);
  const yearStart  = new Date(n.getFullYear(), 0, 1);

  res.json({
    summary: {
      today: bucket(todayStart, new Date(todayStart.getTime() + 86400000)),
      week:  calls.filter(c => new Date(c.createdAt) >= weekStart).length,
      month: calls.filter(c => new Date(c.createdAt) >= monthStart).length,
      year:  calls.filter(c => new Date(c.createdAt) >= yearStart).length,
      total: calls.length,
    },
    perProspect, dialsToConfirm,
    overTime: { day: dayData, week: weekData, month: monthData, year: yearData },
  });
});

// ── Analytics: Team overview (admin only) ─────────────────────────────────────
app.get('/api/analytics/team', requireAdmin, (req, res) => {
  const db       = readDB();
  const allCalls = db.callLogs;
  const allAppts = db.appointments;
  const allUsers = db.users;
  const n          = new Date();
  const todayStart = new Date(n); todayStart.setHours(0,0,0,0);
  const weekStart  = new Date(n); weekStart.setDate(n.getDate() - n.getDay()); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(n.getFullYear(), n.getMonth(), 1);

  const agentStats = u => {
    const uCalls = allCalls.filter(c => c.agent === u.name);
    const uAppts = allAppts.filter(a => a.createdBy === u.username);
    return {
      username: u.username, name: u.name,
      today:        uCalls.filter(c => new Date(c.createdAt) >= todayStart).length,
      week:         uCalls.filter(c => new Date(c.createdAt) >= weekStart).length,
      month:        uCalls.filter(c => new Date(c.createdAt) >= monthStart).length,
      total:        uCalls.length,
      appointments: uAppts.length,
      confirmed:    uAppts.filter(a => a.status === 'confirmed').length,
    };
  };

  const agents  = allUsers.filter(u => u.role === 'agent');
  const teamIds = [...new Set(agents.map(u => u.team).filter(Boolean))];
  const result  = teamIds.map(tid => ({
    teamId: tid, label: TEAMS[tid]?.label || tid,
    members: agents.filter(u => u.team === tid).map(agentStats),
  }));
  const noTeam = agents.filter(u => !u.team).map(agentStats);
  if (noTeam.length) result.push({ teamId: null, label: 'Unassigned', members: noTeam });
  res.json(result);
});

// ── Export (admin only) ───────────────────────────────────────────────────────
app.get('/api/export', requireAdmin, (req, res) => {
  const db = readDB();
  res.setHeader('Content-Disposition', 'attachment; filename="apex-db-export.json"');
  res.json({
    appointments:  db.appointments,
    contacts:      db.contacts,
    callLogs:      db.callLogs,
    prospectNotes: db.prospectNotes,
    activityLog:   db.activityLog,
    users:         db.users.map(({ password, ...u }) => u),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡️  Apex Insurance CRM  →  http://localhost:${PORT}`);
  console.log(`   admin / admin123  |  david / agent123\n`);
});
