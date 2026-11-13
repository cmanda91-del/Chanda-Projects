import crypto from 'node:crypto';
import { config, PLANS, aiProvider } from './config.js';
import { q, tx } from './db.js';
import { HttpError, json, readJson, clientIp, rateLimit, Router } from './http.js';
import { hashPassword, verifyPassword, createToken, sessionCookie, clearCookie, normalizePhone, detectOperator } from './auth.js';
import { SYLLABUS, LANGUAGES, isValidSubject, isValidTopic } from './syllabus.js';
import { generateQuestions, tutorReply } from './ai.js';
import { paymentsEnabled, requestMobileMoney, collectionStatus } from './lenco.js';

export const router = new Router();

// ---------- helpers
const lusakaDay = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
// SQLite datetime('now') is UTC; Lusaka day starts at 22:00 UTC the previous day.
const dayStartUtc = () => new Date(Date.parse(lusakaDay() + 'T00:00:00Z') - 2 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

function isPaid(u) { return Boolean(u.plan_expires_at && Date.parse(u.plan_expires_at) > Date.now()); }

function usage(u) {
  const since = dayStartUtc();
  const questions = q.get('SELECT COUNT(*) n FROM attempts WHERE user_id=? AND created_at>=?', u.id, since).n;
  const tutor = q.get("SELECT COUNT(*) n FROM tutor_messages WHERE user_id=? AND role='user' AND created_at>=?", u.id, since).n;
  const paid = isPaid(u);
  const qLimit = paid ? config.paidQuestionsPerDay : config.freeQuestionsPerDay;
  const tLimit = paid ? config.paidTutorPerDay : config.freeTutorPerDay;
  return { paid, questions, questionsLimit: qLimit, questionsLeft: Math.max(0, qLimit - questions), tutor, tutorLimit: tLimit, tutorLeft: Math.max(0, tLimit - tutor) };
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, phone: u.phone, grade: u.grade, language: u.language, role: u.role,
    plan: isPaid(u) ? u.plan : null, planExpiresAt: isPaid(u) ? u.plan_expires_at : null,
  };
}

function requireUser(ctx) { if (!ctx.user) throw new HttpError(401, 'Please log in'); return ctx.user; }
function requireAdmin(ctx) { const u = requireUser(ctx); if (u.role !== 'admin') throw new HttpError(403, 'Admins only'); return u; }

function str(v, name, { min = 1, max = 200 } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min}-${max} characters`);
  return s;
}

function extendPlan(userId, planId) {
  const plan = PLANS[planId];
  const u = q.get('SELECT * FROM users WHERE id=?', userId);
  const base = isPaid(u) ? Date.parse(u.plan_expires_at) : Date.now();
  const expires = new Date(base + plan.days * 864e5).toISOString();
  q.run('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?', planId, expires, userId);
  return expires;
}

// ---------- public
router.get('/api/health', (ctx) => json(ctx.res, 200, { ok: true, ai: aiProvider(), payments: paymentsEnabled(), time: new Date().toISOString() }));

router.get('/api/meta', (ctx) => json(ctx.res, 200, {
  appName: config.appName,
  ai: aiProvider(),
  payments: paymentsEnabled(),
  languages: LANGUAGES,
  plans: Object.values(PLANS),
  free: { questionsPerDay: config.freeQuestionsPerDay, tutorPerDay: config.freeTutorPerDay },
  grades: Object.fromEntries(Object.entries(SYLLABUS).map(([g, v]) => [g, { label: v.label, subjects: v.subjects }])),
}));

// ---------- auth
router.post('/api/auth/register', async (ctx) => {
  rateLimit('auth:' + clientIp(ctx.req), 10, 60e3);
  const b = await readJson(ctx.req);
  const name = str(b.name, 'Name', { min: 2, max: 60 });
  const phone = normalizePhone(b.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid Zambian mobile number, e.g. 0971234567');
  const password = str(b.password, 'Password', { min: 6, max: 100 });
  const grade = Number(b.grade);
  if (!SYLLABUS[grade]) throw new HttpError(400, 'Choose Grade 7, 9 or 12');
  const language = LANGUAGES.includes(b.language) ? b.language : 'English';
  if (q.get('SELECT id FROM users WHERE phone=?', phone)) throw new HttpError(409, 'This number is already registered. Please log in.');
  const adminPhone = normalizePhone(config.adminPhone);
  const role = adminPhone && adminPhone === phone ? 'admin' : 'learner';
  const r = q.run('INSERT INTO users(name, phone, password_hash, grade, language, role) VALUES (?,?,?,?,?,?)',
    name, phone, hashPassword(password), grade, language, role);
  const u = q.get('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
  json(ctx.res, 201, { user: publicUser(u) }, { 'set-cookie': sessionCookie(createToken(u.id)) });
});

router.post('/api/auth/login', async (ctx) => {
  rateLimit('auth:' + clientIp(ctx.req), 10, 60e3);
  const b = await readJson(ctx.req);
  const phone = normalizePhone(b.phone);
  const u = phone && q.get('SELECT * FROM users WHERE phone=?', phone);
  if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) throw new HttpError(401, 'Wrong phone number or password');
  if (u.role !== 'admin' && normalizePhone(config.adminPhone) === u.phone) {
    q.run("UPDATE users SET role='admin' WHERE id=?", u.id); u.role = 'admin';
  }
  json(ctx.res, 200, { user: publicUser(u) }, { 'set-cookie': sessionCookie(createToken(u.id)) });
});

router.post('/api/auth/logout', (ctx) => json(ctx.res, 200, { ok: true }, { 'set-cookie': clearCookie() }));

router.get('/api/me', (ctx) => {
  const u = requireUser(ctx);
  json(ctx.res, 200, { user: publicUser(u), usage: usage(u) });
});

router.post('/api/me', async (ctx) => {
  const u = requireUser(ctx);
  const b = await readJson(ctx.req);
  const grade = b.grade !== undefined ? Number(b.grade) : u.grade;
  if (!SYLLABUS[grade]) throw new HttpError(400, 'Invalid grade');
  const language = b.language !== undefined ? (LANGUAGES.includes(b.language) ? b.language : null) : u.language;
  if (!language) throw new HttpError(400, 'Invalid language');
  const name = b.name !== undefined ? str(b.name, 'Name', { min: 2, max: 60 }) : u.name;
  q.run('UPDATE users SET grade=?, language=?, name=? WHERE id=?', grade, language, name, u.id);
  const nu = q.get('SELECT * FROM users WHERE id=?', u.id);
  json(ctx.res, 200, { user: publicUser(nu), usage: usage(nu) });
});

// ---------- practice
const generating = new Map(); // de-duplicate concurrent generation for the same topic

async function ensureQuestions(grade, subject, topic, userId, need) {
  const unseenSql = `SELECT COUNT(*) n FROM questions WHERE grade=? AND subject=? AND topic=? AND disabled=0
    AND id NOT IN (SELECT question_id FROM attempts WHERE user_id=?)`;
  if (q.get(unseenSql, grade, subject, topic, userId).n >= need) return;
  const key = `${grade}|${subject}|${topic}`;
  if (!generating.has(key)) {
    const existing = q.all('SELECT question FROM questions WHERE grade=? AND subject=? AND topic=? ORDER BY id DESC LIMIT 25', grade, subject, topic).map((r) => r.question);
    const p = generateQuestions({ grade, subject, topic, count: 8, avoid: existing })
      .then((items) => tx(() => {
        for (const it of items) {
          q.run('INSERT INTO questions(grade, subject, topic, question, options, answer, explanation, source) VALUES (?,?,?,?,?,?,?,?)',
            grade, subject, topic, it.question, JSON.stringify(it.options), it.answer, it.explanation, it.source);
        }
      }))
      .finally(() => generating.delete(key));
    generating.set(key, p);
  }
  await generating.get(key);
}

router.get('/api/practice', async (ctx) => {
  const u = requireUser(ctx);
  const subject = ctx.url.searchParams.get('subject');
  const topic = ctx.url.searchParams.get('topic');
  const count = Math.min(10, Math.max(1, Number(ctx.url.searchParams.get('count')) || 5));
  if (!isValidSubject(u.grade, subject) || !isValidTopic(u.grade, subject, topic)) throw new HttpError(400, 'Choose a subject and topic');
  const use = usage(u);
  if (use.questionsLeft <= 0) throw new HttpError(402, use.paid ? 'Daily fair-use limit reached. Come back tomorrow.' : 'You have used today\'s free questions. Upgrade for unlimited practice, or come back tomorrow.');
  rateLimit('gen:' + u.id, 20, 60e3);
  const want = Math.min(count, use.questionsLeft);
  try { await ensureQuestions(u.grade, subject, topic, u.id, want); }
  catch (e) { console.error('[ai] question generation failed:', e.message); }
  const rows = q.all(`SELECT id, question, options, topic, source FROM questions WHERE grade=? AND subject=? AND topic=? AND disabled=0
    AND id NOT IN (SELECT question_id FROM attempts WHERE user_id=?) ORDER BY random() LIMIT ?`, u.grade, subject, topic, u.id, want);
  if (!rows.length) throw new HttpError(503, 'Could not prepare questions right now. Please try again shortly.');
  json(ctx.res, 200, { questions: rows.map((r) => ({ id: r.id, question: r.question, options: JSON.parse(r.options), topic: r.topic, demo: r.source === 'demo' })), usage: use });
});

router.post('/api/answer', async (ctx) => {
  const u = requireUser(ctx);
  const b = await readJson(ctx.req);
  const qid = Number(b.questionId), choice = Number(b.choice);
  if (!Number.isInteger(qid) || !Number.isInteger(choice) || choice < 0 || choice > 3) throw new HttpError(400, 'Invalid answer');
  const row = q.get('SELECT * FROM questions WHERE id=? AND grade=?', qid, u.grade);
  if (!row) throw new HttpError(404, 'Question not found');
  const prev = q.get('SELECT * FROM attempts WHERE user_id=? AND question_id=?', u.id, qid);
  if (!prev) {
    if (usage(u).questionsLeft <= 0) throw new HttpError(402, 'Daily question limit reached');
    q.run('INSERT INTO attempts(user_id, question_id, choice, correct) VALUES (?,?,?,?)', u.id, qid, choice, choice === row.answer ? 1 : 0);
  }
  json(ctx.res, 200, { correct: (prev ? prev.choice : choice) === row.answer, answer: row.answer, explanation: row.explanation, usage: usage(u) });
});

router.post('/api/report', async (ctx) => {
  const u = requireUser(ctx);
  const b = await readJson(ctx.req);
  const qid = Number(b.questionId);
  if (!q.get('SELECT id FROM questions WHERE id=?', qid)) throw new HttpError(404, 'Question not found');
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 300) : '';
  if (!q.get('SELECT id FROM reports WHERE user_id=? AND question_id=?', u.id, qid)) {
    q.run('INSERT INTO reports(user_id, question_id, reason) VALUES (?,?,?)', u.id, qid, reason);
    q.run('UPDATE questions SET reports = reports + 1 WHERE id=?', qid);
    // Auto-hide a question once 3 learners report it; admin can review.
    q.run('UPDATE questions SET disabled=1 WHERE id=? AND reports>=3', qid);
  }
  json(ctx.res, 200, { ok: true });
});

router.get('/api/progress', (ctx) => {
  const u = requireUser(ctx);
  const bySubject = q.all(`SELECT qs.subject, COUNT(*) attempted, SUM(a.correct) correct FROM attempts a JOIN questions qs ON qs.id=a.question_id
    WHERE a.user_id=? AND qs.grade=? GROUP BY qs.subject ORDER BY qs.subject`, u.id, u.grade);
  const byTopic = q.all(`SELECT qs.subject, qs.topic, COUNT(*) attempted, SUM(a.correct) correct FROM attempts a JOIN questions qs ON qs.id=a.question_id
    WHERE a.user_id=? AND qs.grade=? GROUP BY qs.subject, qs.topic`, u.id, u.grade);
  const weak = byTopic.filter((t) => t.attempted >= 3 && t.correct / t.attempted < 0.6)
    .sort((a, b) => a.correct / a.attempted - b.correct / b.attempted).slice(0, 5);
  const days = q.all(`SELECT date(datetime(created_at, '+2 hours')) day, COUNT(*) n, SUM(correct) c FROM attempts WHERE user_id=?
    GROUP BY day ORDER BY day DESC LIMIT 14`, u.id);
  let streak = 0; const set = new Set(days.map((d) => d.day));
  for (let d = new Date(lusakaDay()); set.has(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1)) streak++;
  const total = q.get('SELECT COUNT(*) n, COALESCE(SUM(correct),0) c FROM attempts WHERE user_id=?', u.id);
  json(ctx.res, 200, { total: { attempted: total.n, correct: total.c }, bySubject, byTopic, weak, days: days.reverse(), streak });
});

// ---------- tutor
router.get('/api/tutor', (ctx) => {
  const u = requireUser(ctx);
  const msgs = q.all('SELECT role, content, created_at FROM tutor_messages WHERE user_id=? ORDER BY id DESC LIMIT 40', u.id).reverse();
  json(ctx.res, 200, { messages: msgs, usage: usage(u) });
});

router.post('/api/tutor', async (ctx) => {
  const u = requireUser(ctx);
  const b = await readJson(ctx.req);
  const message = str(b.message, 'Message', { min: 1, max: 1500 });
  const language = LANGUAGES.includes(b.language) ? b.language : u.language;
  const use = usage(u);
  if (use.tutorLeft <= 0) throw new HttpError(402, use.paid ? 'Daily fair-use limit reached. Come back tomorrow.' : 'You have used today\'s free tutor messages. Upgrade to keep chatting, or come back tomorrow.');
  rateLimit('tutor:' + u.id, 10, 60e3);
  const history = q.all('SELECT role, content FROM tutor_messages WHERE user_id=? ORDER BY id DESC LIMIT 8', u.id).reverse();
  // Anthropic requires the conversation to start with a user turn.
  while (history.length && history[0].role !== 'user') history.shift();
  let reply;
  try { reply = await tutorReply({ grade: u.grade, language, history, message }); }
  catch (e) { console.error('[ai] tutor failed:', e.message); throw new HttpError(503, 'The tutor is busy right now. Please try again in a moment.'); }
  tx(() => {
    q.run("INSERT INTO tutor_messages(user_id, role, content) VALUES (?,'user',?)", u.id, message);
    q.run("INSERT INTO tutor_messages(user_id, role, content) VALUES (?,'assistant',?)", u.id, reply);
  });
  json(ctx.res, 200, { reply, usage: usage(u) });
});

router.post('/api/tutor/clear', (ctx) => {
  const u = requireUser(ctx);
  // Keep today's user messages so the daily allowance cannot be reset by clearing.
  q.run("DELETE FROM tutor_messages WHERE user_id=? AND (role='assistant' OR created_at<?)", u.id, dayStartUtc());
  q.run("UPDATE tutor_messages SET content='(cleared)' WHERE user_id=? AND role='user'", u.id);
  json(ctx.res, 200, { ok: true });
});

// ---------- payments (Lenco mobile money)
async function refreshPayment(p) {
  if (!['pending', 'pay-offline'].includes(p.status) || !paymentsEnabled()) return p;
  try {
    const d = await collectionStatus(p.reference);
    applyPaymentStatus(p.reference, d?.status, d?.lencoReference, d?.reasonForFailure);
  } catch (e) { if (e.status !== 404) console.error('[lenco] status check failed:', e.message); }
  return q.get('SELECT * FROM payments WHERE reference=?', p.reference);
}

function applyPaymentStatus(reference, status, lencoRef, reason) {
  if (!['pending', 'pay-offline', 'successful', 'failed'].includes(status)) return;
  tx(() => {
    const p = q.get('SELECT * FROM payments WHERE reference=?', reference);
    if (!p || p.applied) return;
    q.run("UPDATE payments SET status=?, lenco_reference=COALESCE(?, lenco_reference), failure_reason=?, updated_at=datetime('now') WHERE id=?",
      status, lencoRef || null, reason || null, p.id);
    if (status === 'successful') {
      extendPlan(p.user_id, p.plan);
      q.run('UPDATE payments SET applied=1 WHERE id=?', p.id);
    }
  });
}

const publicPayment = (p) => ({ reference: p.reference, plan: p.plan, amount: p.amount, status: p.status, failureReason: p.failure_reason, createdAt: p.created_at });

router.post('/api/pay', async (ctx) => {
  const u = requireUser(ctx);
  if (!paymentsEnabled()) throw new HttpError(503, 'Mobile money payments are being set up. Please check back soon.');
  rateLimit('pay:' + u.id, 5, 60e3);
  const b = await readJson(ctx.req);
  const plan = PLANS[b.plan];
  if (!plan) throw new HttpError(400, 'Choose a plan');
  const phone = normalizePhone(b.phone || u.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid Airtel, MTN or Zamtel number');
  const operator = ['airtel', 'mtn', 'zamtel'].includes(b.operator) ? b.operator : detectOperator(phone);
  if (!operator) throw new HttpError(400, 'Choose your mobile money network');
  const reference = `zp-${u.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  q.run('INSERT INTO payments(user_id, reference, plan, amount, phone, operator) VALUES (?,?,?,?,?,?)', u.id, reference, plan.id, plan.price, phone, operator);
  try {
    const d = await requestMobileMoney({ amount: plan.price, reference, phone, operator });
    applyPaymentStatus(reference, d?.status || 'pending', d?.lencoReference, d?.reasonForFailure);
  } catch (e) {
    console.error('[lenco] collection failed:', e.message);
    q.run("UPDATE payments SET status='failed', failure_reason=?, updated_at=datetime('now') WHERE reference=?", e.message.slice(0, 200), reference);
    throw new HttpError(502, 'Could not start the mobile money payment. Check the number and try again.');
  }
  json(ctx.res, 200, { payment: publicPayment(q.get('SELECT * FROM payments WHERE reference=?', reference)) });
});

router.get('/api/pay/:ref', async (ctx) => {
  const u = requireUser(ctx);
  let p = q.get('SELECT * FROM payments WHERE reference=? AND user_id=?', ctx.params.ref, u.id);
  if (!p) throw new HttpError(404, 'Payment not found');
  p = await refreshPayment(p);
  const nu = q.get('SELECT * FROM users WHERE id=?', u.id);
  json(ctx.res, 200, { payment: publicPayment(p), user: publicUser(nu) });
});

router.get('/api/payments', (ctx) => {
  const u = requireUser(ctx);
  json(ctx.res, 200, { payments: q.all('SELECT * FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id).map(publicPayment) });
});

// Lenco webhook: never trust the payload; re-check status with Lenco before applying.
router.post('/api/webhooks/lenco', async (ctx) => {
  const b = await readJson(ctx.req, 64 * 1024).catch(() => ({}));
  const ref = b?.data?.reference || b?.reference;
  if (typeof ref === 'string' && ref.startsWith('zp-')) {
    const p = q.get('SELECT * FROM payments WHERE reference=?', ref);
    if (p) await refreshPayment(p);
  }
  json(ctx.res, 200, { received: true });
});

// ---------- admin
router.get('/api/admin/stats', (ctx) => {
  requireAdmin(ctx);
  const since = dayStartUtc();
  const now = new Date().toISOString();
  json(ctx.res, 200, {
    ai: aiProvider(), payments: paymentsEnabled(),
    users: q.get('SELECT COUNT(*) n FROM users').n,
    newToday: q.get('SELECT COUNT(*) n FROM users WHERE created_at>=?', since).n,
    activePaid: q.get('SELECT COUNT(*) n FROM users WHERE plan_expires_at>?', now).n,
    byGrade: q.all('SELECT grade, COUNT(*) n FROM users GROUP BY grade'),
    revenue: q.get("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM payments WHERE status='successful'"),
    revenue30: q.get("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE status='successful' AND created_at>=datetime('now','-30 days')").total,
    answersToday: q.get('SELECT COUNT(*) n FROM attempts WHERE created_at>=?', since).n,
    tutorToday: q.get("SELECT COUNT(*) n FROM tutor_messages WHERE role='user' AND created_at>=?", since).n,
    questionBank: q.get('SELECT COUNT(*) n, SUM(disabled) disabled FROM questions'),
    aiCalls7d: q.all("SELECT kind, provider, COUNT(*) n, SUM(ok) ok, CAST(AVG(ms) AS INTEGER) avg_ms FROM ai_usage WHERE created_at>=datetime('now','-7 days') GROUP BY kind, provider"),
    recentPayments: q.all('SELECT p.reference, p.plan, p.amount, p.status, p.phone, p.created_at, u.name FROM payments p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 15'),
  });
});

router.get('/api/admin/users', (ctx) => {
  requireAdmin(ctx);
  const s = (ctx.url.searchParams.get('q') || '').trim();
  const like = `%${s}%`;
  const rows = q.all(`SELECT id, name, phone, grade, role, plan, plan_expires_at, created_at,
      (SELECT COUNT(*) FROM attempts a WHERE a.user_id=users.id) answers
    FROM users WHERE (?='' OR name LIKE ? OR phone LIKE ?) ORDER BY id DESC LIMIT 50`, s, like, like);
  json(ctx.res, 200, { users: rows });
});

router.post('/api/admin/grant', async (ctx) => {
  const admin = requireAdmin(ctx);
  const b = await readJson(ctx.req);
  const plan = PLANS[b.plan];
  const user = q.get('SELECT * FROM users WHERE id=?', Number(b.userId));
  if (!plan || !user) throw new HttpError(400, 'Choose a user and plan');
  const reference = `manual-${user.id}-${Date.now().toString(36)}`;
  tx(() => {
    q.run("INSERT INTO payments(user_id, reference, plan, amount, phone, operator, status, applied, failure_reason) VALUES (?,?,?,?,?,'manual','manual',1,?)",
      user.id, reference, plan.id, Number(b.amount) || 0, user.phone, `Granted by admin #${admin.id}`);
    extendPlan(user.id, plan.id);
  });
  json(ctx.res, 200, { ok: true });
});

router.get('/api/admin/reports', (ctx) => {
  requireAdmin(ctx);
  json(ctx.res, 200, {
    questions: q.all(`SELECT q.id, q.grade, q.subject, q.topic, q.question, q.options, q.answer, q.explanation, q.disabled, q.reports,
      (SELECT group_concat(reason, ' | ') FROM reports r WHERE r.question_id=q.id) reasons
      FROM questions q WHERE q.reports>0 ORDER BY q.disabled ASC, q.reports DESC LIMIT 50`),
  });
});

router.post('/api/admin/questions/:id', async (ctx) => {
  requireAdmin(ctx);
  const b = await readJson(ctx.req);
  const id = Number(ctx.params.id);
  if (b.action === 'disable') q.run('UPDATE questions SET disabled=1 WHERE id=?', id);
  else if (b.action === 'restore') q.run('UPDATE questions SET disabled=0, reports=0 WHERE id=?', id);
  else throw new HttpError(400, 'Unknown action');
  json(ctx.res, 200, { ok: true });
});
