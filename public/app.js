// ZedPrep single-page app. No build step, no dependencies.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEYS = ['A', 'B', 'C', 'D'];

const state = { meta: null, user: null, usage: null, session: null, tutorBusy: false };

// ---------- API
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}
function render(html) { app.innerHTML = html; app.focus({ preventScroll: true }); window.scrollTo(0, 0); }
function formError(form, msg) {
  let el = $('.form-error', form);
  if (!el) { el = document.createElement('div'); el.className = 'form-error'; form.append(el); }
  el.textContent = msg;
}
async function busy(btn, fn) {
  const label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Please wait…';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}
const kwacha = (n) => `K${Number(n).toLocaleString('en-ZM', { maximumFractionDigits: 2 })}`;
const fmtDate = (s) => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const pct = (c, n) => (n ? Math.round((100 * c) / n) : 0);
const meterClass = (p) => (p >= 70 ? '' : p >= 50 ? 'warn' : 'bad');
// Light formatting for tutor replies: escape first, then **bold** and line breaks are kept by CSS.
const fmtMsg = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// ---------- chrome
function chrome() {
  const right = $('#topbar-right');
  if (state.user) {
    const pro = state.user.plan;
    right.innerHTML = pro
      ? `<a class="chip pro" href="#/plans">★ Premium</a>`
      : `<a class="chip" href="#/plans">Upgrade</a>`;
  } else {
    right.innerHTML = `<a class="chip" href="#/login">Log in</a>`;
  }
  $('#tabbar').hidden = !state.user;
  const tab = location.hash.split('/')[1] || 'home';
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const banner = $('#banner');
  if (state.meta?.ai === 'demo' && state.user?.role === 'admin') {
    banner.hidden = false; banner.textContent = 'Demo mode: add ANTHROPIC_API_KEY or OPENAI_API_KEY in Railway to switch on real AI questions and tutoring.';
  } else banner.hidden = true;
}

async function refreshMe() {
  try { const d = await api('/api/me'); state.user = d.user; state.usage = d.usage; }
  catch (e) { if (e.status === 401) { state.user = null; state.usage = null; } else throw e; }
}

// ---------- views
const views = {};

views.landing = () => {
  const m = state.meta;
  const plans = m.plans.map((p, i) => `
    <div class="card plan ${i === 1 ? 'best' : ''}">
      <h3>${esc(p.name)}</h3><div class="price">${kwacha(p.price)}</div>
      <p class="muted small">${p.days} days of unlimited practice and tutoring</p>
    </div>`).join('');
  render(`
    <section class="hero">
      <h1>Pass your exams with your own AI tutor</h1>
      <p>Practice questions for Grade 7, 9 and 12, marked instantly with step-by-step explanations. Ask the tutor anything, in English, Nyanja, Bemba, Tonga or Lozi.</p>
      <div class="row"><a class="btn alt" href="#/signup">Start free</a><a class="btn" href="#/login">Log in</a></div>
    </section>
    <div class="grid two">
      <div class="card feature"><div class="ic">✎</div><div><h3>Exam-style practice</h3><p class="muted small">Questions by subject and topic, following the ECZ syllabus areas.</p></div></div>
      <div class="card feature"><div class="ic">✓</div><div><h3>Instant marking</h3><p class="muted small">See the right answer and why, straight away.</p></div></div>
      <div class="card feature"><div class="ic">💬</div><div><h3>Tutor in your language</h3><p class="muted small">Explanations in English or a Zambian language.</p></div></div>
      <div class="card feature"><div class="ic">▲</div><div><h3>Track your progress</h3><p class="muted small">See your scores and the topics you need to work on.</p></div></div>
    </div>
    <h2 style="margin-top:1rem">Simple prices</h2>
    <p class="muted">Free every day: ${m.free.questionsPerDay} questions and ${m.free.tutorPerDay} tutor messages. Pay with Airtel Money, MTN MoMo or Zamtel Kwacha for more.</p>
    X{plans}</div>
    <a class="btn block alt" href="#/signup">Create a free account</a>
    <footer class="site">© ${new Date().getFullYear()} ZedPrep · Made in Zambia</footer>`);
};

function authForm(mode) {
  const m = state.meta;
  const isSignup = mode === 'signup';
  render(`
    <div class="card">
      <h1>${isSignup ? 'Create your free account' : 'Welcome back'}</h1>
      <form id="f" novalidate>
        ${isSignup ? `<label for="name">Your name</label><input id="name" name="name" autocomplete="name" required maxlength="60">` : ''}
        <label for="phone">Phone number</label>
        <input id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="e.g. 0971234567" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="6" required>
        ${isSignup ? `
          <label>Which exam are you preparing for?</label>
          <div class="seg" id="grades">${Object.keys(m.grades).map((g) => `<button type="button" data-g="${g}">Grade ${g}</button>`).join('')}</div>
          <label for="language">Preferred language for explanations</label>
          <select id="language" name="language">${m.languages.map((l) => `<option>${esc(l)}</option>`).join('')}</select>` : ''}
        <button class="btn block" style="margin-top:1rem" type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="center small" style="margin-top:1rem">${isSignup ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/signup">Create a free account</a>'}</p>
    </div>`);
  let grade = null;
  $$('#grades button').forEach((b) => b.onclick = () => { grade = b.dataset.g; $$('#grades button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target; const fd = Object.fromEntries(new FormData(f));
    if (isSignup && !grade) return formError(f, 'Choose your grade');
    await busy($('button[type=submit]', f), async () => {
      try {
        const d = await api(`/api/auth/${isSignup ? 'register' : 'login'}`, { method: 'POST', body: { ...fd, grade } });
        state.user = d.user; await refreshMe(); location.hash = '#/home';
      } catch (err) { formError(f, err.message); }
    });
  };
}
views.signup = () => authForm('signup');
views.login = () => authForm('login');

function usageLine() {
  const u = state.usage; if (!u) return '';
  if (u.paid) return `<span class="badge ok">Premium</span> <span class="muted small">until ${fmtDate(state.user.planExpiresAt)}</span>`;
  return `<span class="muted small">Free today: <b>${u.questionsLeft}</b> questions · <b>${u.tutorLeft}</b> tutor messages left</span> · <a class="small" href="#/plans">Upgrade</a>`;
}

views.home = async () => {
  const p = await api('/api/progress').catch(() => null);
  const g = state.meta.grades[state.user.grade];
  const subjects = Object.keys(g.subjects).map((s) => `<a class="item" href="#/practice/${encodeURIComponent(s)}"><span>${esc(s)}</span><span class="arrow">›</span></a>`).join('');
  const weak = p?.weak?.length ? `
    <div class="card"><h3>Topics to work on</h3><div class="list">
      ${p.weak.map((w) => `<a class="item" href="#/practice/${encodeURIComponent(w.subject)}/${encodeURIComponent(w.topic)}">
        <span>${esc(w.topic)} <span class="muted small">· ${esc(w.subject)}</span></span><span class="badge bad">${pct(w.correct, w.attempted)}%</span></a>`).join('')}
    </div></div>` : '';
  render(`
    <h1>Hello, ${esc(state.user.name.split(' ')[0])} 👋</h1>
    <p class="muted">${esc(g.label)}</p>
    <div class="card">${usageLine()}</div>
    ${p ? `<div class="grid stats">
      <div class="card stat"><b>${p.total.attempted}</b><span class="small muted">Questions done</span></div>
      <div class="card stat"><b>${pct(p.total.correct, p.total.attempted)}%</b><span class="small muted">Average score</span></div>
      <div class="card stat"><b>${p.streak}🔥</b><span class="small muted">Day streak</span></div></div>` : ''}
    ${weak}
    <div class="row" style="margin-bottom:.5rem"><h2 style="margin:0">Practise a subject</h2></div>
    <div class="list">${subjects}</div>
    <a class="btn block alt" style="margin-top:1rem" href="#/tutor">💬 Ask the tutor a question</a>`);
};

views.practice = async (subject, topic) => {
  const g = state.meta.grades[state.user.grade];
  if (!subject) {
    return render(`<h1>Practice</h1><p class="muted">Choose a subject</p>
      <div class="list">${Object.keys(g.subjects).map((s) => `<a class="item" href="#/practice/${encodeURIComponent(s)}"><span>${esc(s)}</span><span class="arrow">›</span></a>`).join('')}</div>`);
  }
  const topics = g.subjects[subject];
  if (!topics) { location.hash = '#/practice'; return; }
  if (!topic) {
    return render(`<div class="crumbs"><a href="#/practice">Practice</a> › ${esc(subject)}</div><h1>${esc(subject)}</h1><p class="muted">Choose a topic</p>
      <div class="list">${topics.map((t) => `<a class="item" href="#/practice/${encodeURIComponent(subject)}/${encodeURIComponent(t)}"><span>${esc(t)}</span><span class="arrow">›</span></a>`).join('')}</div>`);
  }
  render(`<div class="crumbs"><a href="#/practice">Practice</a> › <a href="#/practice/${encodeURIComponent(subject)}">${esc(subject)}</a> › ${esc(topic)}</div>
    <div class="card center"><p><b>Preparing your questions…</b></p><p class="muted small">New questions can take up to 30 seconds to write.</p></div>`);
  try {
    const d = await api(`/api/practice?subject=${encodeURIComponent(subject)}&topic=${encodeURIComponent(topic)}&count=5`);
    state.usage = d.usage;
    state.session = { subject, topic, questions: d.questions, i: 0, score: 0, answered: false };
    quizStep();
  } catch (e) { limitOrError(e, `#/practice/${encodeURIComponent(subject)}`); }
};

function limitOrError(e, back) {
  if (e.status === 402) {
    render(`<div class="card center"><h2>Daily limit reached</h2><p>${esc(e.message)}</p>
      <a class="btn alt block" href="#/plans">See plans</a><p></p><a href="${back}">Go back</a></div>`);
  } else {
    render(`<div class="card center"><h2>Sorry</h2><p>${esc(e.message)}</p><a class="btn block" href="${back}">Go back</a></div>`);
  }
}

function quizStep() {
  const s = state.session; const qn = s.questions[s.i];
  if (!qn) return quizDone();
  render(`
    <div class="crumbs"><a href="#/practice/${encodeURIComponent(s.subject)}">${esc(s.subject)}</a> › ${esc(s.topic)}</div>
    <div class="card">
      <div class="qhead"><span>Question ${s.i + 1} of ${s.questions.length}</span><span>Score ${s.score}</span></div>
      <div class="meter" style="margin-bottom:1rem"><i style="width:${(100 * s.i) / s.questions.length}%"></i></div>
      <div class="question">${esc(qn.question)}</div>
      <div class="opts">${qn.options.map((o, k) => `<button class="opt" data-k="${k}"><span class="k">${KEYS[k]}</span><span>${esc(o)}</span></button>`).join('')}</div>
      <div id="fb"></div>
    </div>`);
  $$('.opt').forEach((b) => b.onclick = () => answer(Number(b.dataset.k)));
}

async function answer(k) {
  const s = state.session; const qn = s.questions[s.i];
  if (s.answered) return; s.answered = true;
  $$('.opt').forEach((b) => (b.disabled = true));
  try {
    const d = await api('/api/answer', { method: 'POST', body: { questionId: qn.id, choice: k } });
    state.usage = d.usage;
    if (d.correct) s.score++;
    $$('.opt').forEach((b) => {
      const kk = Number(b.dataset.k);
      if (kk === d.answer) b.classList.add('right'); else if (kk === k) b.classList.add('wrong');
    });
    const last = s.i === s.questions.length - 1;
    $('#fb').innerHTML = `
      <div class="explain ${d.correct ? '' : 'bad'}"><b>${d.correct ? '✓ Correct!' : `✗ The answer is ${KEYS[d.answer]}`}</b><p style="margin:.3rem 0 0">${esc(d.explanation)}</p></div>
      <div class="row" style="margin-top:1rem">
        <button class="btn link" id="report">Report a problem</button><span class="spacer"></span>
        <button class="btn" id="next">${last ? 'See results' : 'Next question'}</button></div>`;
    $('#next').onclick = () => { s.i++; s.answered = false; quizStep(); };
    $('#report').onclick = async () => {
      const reason = prompt('What is wrong with this question? (optional)') ?? null;
      if (reason === null) return;
      await api('/api/report', { method: 'POST', body: { questionId: qn.id, reason } }).catch(() => {});
      toast('Thank you. We will review this question.');
      $('#report').remove();
    };
    $('#next').focus();
  } catch (e) {
    if (e.status === 402) return limitOrError(e, '#/practice');
    s.answered = false; $$('.opt').forEach((b) => (b.disabled = false)); toast(e.message);
  }
}

function quizDone() {
  const s = state.session; const n = s.questions.length; const p = pct(s.score, n);
  const msg = p >= 80 ? 'Excellent work!' : p >= 50 ? 'Good effort. Keep practising!' : 'Keep going. Practice makes progress!';
  render(`
    <div class="card center">
      <p class="muted">${esc(s.subject)} · ${esc(s.topic)}</p>
      <div class="score">${s.score}/${n}</div><p><b>${msg}</b></p>
      <div class="grid two">
        <a class="btn" href="#/practice/${encodeURIComponent(s.subject)}/${encodeURIComponent(s.topic)}?again=${Date.now()}">Practise again</a>
        <a class="btn ghost" href="#/tutor?topic=${encodeURIComponent(s.topic)}">Ask the tutor about this</a>
      </div>
      <p style="margin-top:1rem">${usageLine()}</p>
    </div>
    <a class="btn link" href="#/practice/${encodeURIComponent(s.subject)}">Choose another topic</a>`);
}

views.tutor = async (_a, _b, query) => {
  const d = await api('/api/tutor');
  state.usage = d.usage;
  const lang = state.user.language;
  const topic = query.get('topic');
  const ideas = topic
    ? [`Explain ${topic} simply`, `Give me an exam tip on ${topic}`, `Test me with one question on ${topic}`]
    : ['Explain fractions simply', 'How do I write a good summary?', 'What is photosynthesis?', 'Give me a revision timetable'];
  render(`
    <div class="row"><h1 style="margin:0">AI Tutor</h1><span class="spacer"></span>
      <select id="lang" style="width:auto;min-height:38px">${state.meta.languages.map((l) => `<option ${l === lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <p class="muted small" id="tusage">${tutorUsage()}</p>
    <div class="chat" id="chat">
      ${d.messages.length ? d.messages.filter((m) => m.content !== '(cleared)').map((m) => `<div class="msg ${m.role}">${fmtMsg(m.content)}</div>`).join('')
        : `<div class="msg assistant">Hello ${esc(state.user.name.split(' ')[0])}! I am your tutor. Ask me about any topic in your Grade ${state.user.grade} subjects.</div>`}
    </div>
    <div class="suggest">${ideas.map((t) => `<button type="button">${esc(t)}</button>`).join('')}</div>
    <form class="composer" id="cf">
      <textarea id="msg" rows="1" placeholder="Type your question…" maxlength="1500" aria-label="Message"></textarea>
      <button class="btn" type="submit" aria-label="Send">Send</button>
    </form>
    ${d.messages.length ? '<button class="btn link small" id="clear">Clear conversation</button>' : ''}`);
  const chat = $('#chat'); chat.lastElementChild?.scrollIntoView({ block: 'end' });
  const ta = $('#msg');
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#cf').requestSubmit(); } };
  $$('.suggest button').forEach((b) => b.onclick = () => { ta.value = b.textContent; $('#cf').requestSubmit(); });
  $('#lang').onchange = (e) => api('/api/me', { method: 'POST', body: { language: e.target.value } }).then((r) => { state.user = r.user; toast(`Tutor will reply in ${r.user.language}`); });
  if ($('#clear')) $('#clear').onclick = async () => { await api('/api/tutor/clear', { method: 'POST', body: {} }); route(); };
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text || state.tutorBusy) return;
    state.tutorBusy = true; ta.value = ''; ta.style.height = 'auto';
    chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div><div class="msg assistant typing" id="typing">Thinking…</div>`);
    $('#typing').scrollIntoView({ block: 'end' });
    try {
      const r = await api('/api/tutor', { method: 'POST', body: { message: text, language: $('#lang').value } });
      state.usage = r.usage;
      $('#typing').outerHTML = `<div class="msg assistant">${fmtMsg(r.reply)}</div>`;
      $('#tusage').innerHTML = tutorUsage();
    } catch (err) {
      $('#typing').outerHTML = `<div class="msg assistant">${esc(err.message)}${err.status === 402 ? ' <a href="#/plans">See plans</a>' : ''}</div>`;
    } finally { state.tutorBusy = false; chat.lastElementChild.scrollIntoView({ block: 'end' }); }
  };
};
function tutorUsage() {
  const u = state.usage; if (!u) return '';
  return u.paid ? 'Premium: unlimited tutoring (fair use)' : `${u.tutorLeft} of ${u.tutorLimit} free messages left today · <a href="#/plans">Upgrade</a>`;
}

views.progress = async () => {
  const p = await api('/api/progress');
  const subj = p.bySubject.map((s) => { const v = pct(s.correct, s.attempted); return `
    <div style="margin-bottom:.8rem"><div class="row"><span>${esc(s.subject)}</span><span class="spacer"></span><span class="small muted">${s.correct}/${s.attempted} · <b>${v}%</b></span></div>
    <div class="meter ${meterClass(v)}"><i style="width:${v}%"></i></div></div>`; }).join('');
  const days = p.days.map((d) => `<div title="${esc(d.day)}: ${d.n} questions" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:90px">
    <div style="width:70%;background:var(--green);border-radius:4px 4px 0 0;height:${Math.max(4, Math.min(100, d.n * 4))}%"></div>
    <span class="small muted" style="font-size:.65rem">${esc(d.day.slice(8))}</span></div>`).join('');
  render(`
    <h1>Your progress</h1>
    <div class="grid stats">
      <div class="card stat"><b>${p.total.attempted}</b><span class="small muted">Questions</span></div>
      <div class="card stat"><b>${pct(p.total.correct, p.total.attempted)}%</b><span class="small muted">Average</span></div>
      <div class="card stat"><b>${p.streak}🔥</b><span class="small muted">Day streak</span></div>
    </div>
    ${p.days.length ? `<div class="card"><h3>Last 14 days</h3><div style="display:flex;gap:2px">${days}</div></div>` : ''}
    <div class="card"><h3>By subject</h3>${subj || '<p class="muted">No practice yet. <a href="#/practice">Start practising</a>.</p>'}</div>
    ${p.weak.length ? `<div class="card"><h3>Focus on these topics</h3><div class="list">${p.weak.map((w) => `
      <a class="item" href="#/practice/${encodeURIComponent(w.subject)}/${encodeURIComponent(w.topic)}"><span>${esc(w.topic)} <span class="muted small">· ${esc(w.subject)}</span></span>
      <span class="badge bad">${pct(w.correct, w.attempted)}%</span></a>`).join('')}</div></div>` : ''}`);
};

views.plans = async () => {
  const m = state.meta;
  const u = state.user;
  const pays = u ? (await api('/api/payments').catch(() => ({ payments: [] }))).payments : [];
  render(`
    <h1>Go Premium</h1>
    ${u?.plan ? `<div class="card"><span class="badge ok">Active</span> Premium until <b>${fmtDate(u.planExpiresAt)}</b>. Buying again adds days to your plan.</div>` : ''}
    <p class="muted">Unlimited practice and tutoring (fair use). Pay by mobile money and approve on your phone.</p>
    <div class="grid three" id="plans">${m.plans.map((p, i) => `
      <button type="button" class="card plan item ${i === 1 ? 'best' : ''}" data-plan="${p.id}" style="display:block">
        <h3>${esc(p.name)}</h3><div class="price">${kwacha(p.price)}</div><span class="muted small">${p.days} days</span></button>`).join('')}</div>
    <form id="pf" class="card" hidden>
      <h3 id="ptitle"></h3>
      ${m.payments ? `
      <label for="pphone">Mobile money number</label>
      <input id="pphone" name="phone" inputmode="tel" value="${esc(u?.phone || '')}" required>
      <label for="op">Network</label>
      <select id="op" name="operator"><option value="">Detect from number</option><option value="airtel">Airtel Money</option><option value="mtn">MTN MoMo</option><option value="zamtel">Zamtel Kwacha</option></select>
      <button class="btn alt block" style="margin-top:1rem" type="submit">Pay now</button>
      <p class="small muted" style="margin-top:.5rem">You will get a prompt on your phone. Enter your PIN to approve.</p>`
      : `<p>Mobile money payments are being set up. Please check back soon.</p>`}
    </form>
    <div id="pstatus"></div>
    ${pays.length ? `<div class="card"><h3>Your payments</h3><div class="table-wrap"><table><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th></tr>
      ${pays.map((p) => `<tr><td>${fmtDate(p.createdAt)}</td><td>${esc(p.plan)}</td><td>${kwacha(p.amount)}</td><td>${statusBadge(p.status)}</td></tr>`).join('')}</table></div></div>` : ''}`);
  let plan = null;
  $$('#plans [data-plan]').forEach((b) => b.onclick = () => {
    if (!state.user) { location.hash = '#/signup'; return; }
    plan = m.plans.find((p) => p.id === b.dataset.plan);
    $$('#plans [data-plan]').forEach((x) => (x.style.outline = x === b ? '3px solid var(--green)' : ''));
    $('#pf').hidden = false; $('#ptitle').textContent = `${plan.name} · ${kwacha(plan.price)}`;
    $('#pf').scrollIntoView({ behavior: 'smooth' });
  });
  const pf = $('#pf');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(pf));
    await busy($('button[type=submit]', pf), async () => {
      try {
        const d = await api('/api/pay', { method: 'POST', body: { plan: plan.id, ...fd } });
        pf.hidden = true; pollPayment(d.payment.reference);
      } catch (err) { formError(pf, err.message); }
    });
  };
};
function statusBadge(s) {
  const map = { successful: ['ok', 'Paid'], manual: ['ok', 'Granted'], failed: ['bad', 'Failed'], pending: ['wait', 'Pending'], 'pay-offline': ['wait', 'Approve on phone'] };
  const [c, t] = map[s] || ['', s]; return `<span class="badge ${c}">${esc(t)}</span>`;
}
async function pollPayment(ref) {
  const box = $('#pstatus');
  const show = (html) => { if (document.body.contains(box)) box.innerHTML = `<div class="card center">${html}</div>`; };
  show('<h3>Check your phone 📱</h3><p>Approve the payment by entering your mobile money PIN.</p><p class="muted small">Waiting for confirmation…</p>');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 4000 : 8000));
    if (!document.body.contains(box)) return;
    try {
      const d = await api(`/api/pay/${encodeURIComponent(ref)}`);
      if (d.payment.status === 'successful') {
        state.user = d.user; await refreshMe(); chrome();
        return show(`<h2>Payment received ✓</h2><p>Premium is active until <b>${fmtDate(d.user.planExpiresAt)}</b>.</p><a class="btn block" href="#/practice">Start practising</a>`);
      }
      if (d.payment.status === 'failed') return show(`<h3>Payment not completed</h3><p>${esc(d.payment.failureReason || 'The payment was declined or timed out.')}</p><button class="btn block" data-reload>Try again</button>`);
    } catch {}
  }
  show('<h3>Still waiting</h3><p>If you approved the payment, it will show on this page shortly. Refresh to check.</p>');
}

views.account = async () => {
  const u = state.user; const m = state.meta;
  render(`
    <h1>Account</h1>
    <form class="card" id="af">
      <label for="aname">Name</label><input id="aname" name="name" value="${esc(u.name)}" maxlength="60">
      <label>Phone</label><input value="${esc(u.phone)}" disabled>
      <label>Exam grade</label>
      <div class="seg" id="grades">${Object.keys(m.grades).map((g) => `<button type="button" data-g="${g}" class="${String(u.grade) === g ? 'on' : ''}">Grade ${g}</button>`).join('')}</div>
      <label for="alang">Tutor language</label>
      <select id="alang" name="language">${m.languages.map((l) => `<option ${l === u.language ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <button class="btn block" style="margin-top:1rem" type="submit">Save changes</button>
    </form>
    <div class="card">${usageLine()}</div>
    ${u.role === 'admin' ? '<a class="btn ghost block" href="#/admin" style="margin-bottom:1rem">Admin dashboard</a>' : ''}
    <button class="btn link" id="logout">Log out</button>`);
  let grade = u.grade;
  $$('#grades button').forEach((b) => b.onclick = () => { grade = Number(b.dataset.g); $$('#grades button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#af').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await busy($('button[type=submit]', e.target), async () => {
      try { const d = await api('/api/me', { method: 'POST', body: { ...fd, grade } }); state.user = d.user; state.usage = d.usage; toast('Saved'); }
      catch (err) { formError(e.target, err.message); }
    });
  };
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); state.user = null; location.hash = '#/'; };
};

views.admin = async () => {
  if (state.user.role !== 'admin') { location.hash = '#/home'; return; }
  const [s, r] = await Promise.all([api('/api/admin/stats'), api('/api/admin/reports')]);
  const plansOpts = state.meta.plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  render(`
    <h1>Admin</h1>
    <div class="card small">AI: <b>${esc(s.ai)}</b> · Payments: <b>${s.payments ? 'Lenco on' : 'off'}</b></div>
    <div class="grid stats">
      <div class="card stat"><b>${s.users}</b><span class="small muted">Learners (+${s.newToday} today)</span></div>
      <div class="card stat"><b>${s.activePaid}</b><span class="small muted">Active premium</span></div>
      <div class="card stat"><b>${kwacha(s.revenue30)}</b><span class="small muted">Revenue 30 days</span></div>
      <div class="card stat"><b>${kwacha(s.revenue.total)}</b><span class="small muted">Revenue all time</span></div>
      <div class="card stat"><b>${s.answersToday}</b><span class="small muted">Answers today</span></div>
      <div class="card stat"><b>${s.tutorToday}</b><span class="small muted">Tutor msgs today</span></div>
    </div>
    <div class="card"><h3>Question bank</h3><p>${s.questionBank.n} questions (${s.questionBank.disabled || 0} hidden) · Users by grade: ${s.byGrade.map((g) => `G${g.grade}: ${g.n}`).join(', ') || '-'}</p>
      <p class="small muted">AI calls (7 days): ${s.aiCalls7d.map((a) => `${esc(a.kind)} ${a.ok}/${a.n} ok, ~${a.avg_ms}ms`).join(' · ') || 'none'}</p></div>
    <div class="card"><h3>Learners</h3>
      <div class="row"><input id="uq" placeholder="Search name or phone" style="flex:1"><button class="btn sm" id="us">Search</button></div>
      <div class="table-wrap" id="ut" style="margin-top:.5rem"></div></div>
    <div class="card"><h3>Recent payments</h3><div class="table-wrap"><table><tr><th>Date</th><th>Learner</th><th>Plan</th><th>Amount</th><th>Status</th></tr>
      ${s.recentPayments.map((p) => `<tr><td>${fmtDate(p.created_at)}</td><td>${esc(p.name)}<br><span class="muted">${esc(p.phone)}</span></td><td>${esc(p.plan)}</td><td>${kwacha(p.amount)}</td><td>${statusBadge(p.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet</td></tr>'}
    </table></div></div>
    <div class="card"><h3>Reported questions</h3>${r.questions.length ? r.questions.map((x) => `
      <div style="border-top:1px solid var(--line);padding:.6rem 0">
        <div class="small muted">G${x.grade} · ${esc(x.subject)} · ${esc(x.topic)} · ${x.reports} report(s) ${x.disabled ? '<span class="badge bad">hidden</span>' : ''}</div>
        <div><b>${esc(x.question)}</b></div>
        <ol type="A" class="small">${JSON.parse(x.options).map((o, k) => `<li ${k === x.answer ? 'style="font-weight:700;color:var(--green)"' : ''}>${esc(o)}</li>`).join('')}</ol>
        <div class="small">${esc(x.explanation)}</div>
        ${x.reasons ? `<div class="small muted">Learner notes: ${esc(x.reasons)}</div>` : ''}
        <button class="btn sm ${x.disabled ? '' : 'alt'}" data-qid="${x.id}" data-act="${x.disabled ? 'restore' : 'disable'}" style="margin-top:.4rem">${x.disabled ? 'Restore' : 'Hide question'}</button>
      </div>`).join('') : '<p class="muted">No reports.</p>'}</div>`);
  const loadUsers = async () => {
    const d = await api(`/api/admin/users?q=${encodeURIComponent($('#uq').value)}`);
    $('#ut').innerHTML = `<table><tr><th>Learner</th><th>Grade</th><th>Answers</th><th>Plan</th><th>Grant</th></tr>${d.users.map((x) => `
      <tr><td>${esc(x.name)}<br><span class="muted">${esc(x.phone)}</span></td><td>${x.grade}</td><td>${x.answers}</td>
      <td>${x.plan_expires_at && Date.parse(x.plan_expires_at) > Date.now() ? `<span class="badge ok">${esc(x.plan)}</span><br><span class="muted">${fmtDate(x.plan_expires_at)}</span>` : '<span class="muted">free</span>'}</td>
      <td><select data-uid="${x.id}" style="min-height:32px;padding:.2rem"><option value="">-</option>${plansOpts}</select></td></tr>`).join('')}</table>`;
    $$('#ut select').forEach((sel) => sel.onchange = async () => {
      if (!sel.value) return;
      if (!confirm(`Grant ${sel.value} plan to this learner (e.g. cash payment)?`)) { sel.value = ''; return; }
      await api('/api/admin/grant', { method: 'POST', body: { userId: Number(sel.dataset.uid), plan: sel.value } });
      toast('Plan granted'); loadUsers();
    });
  };
  $('#us').onclick = loadUsers; $('#uq').onkeydown = (e) => { if (e.key === 'Enter') loadUsers(); };
  loadUsers();
  $$('[data-qid]').forEach((b) => b.onclick = async () => {
    await api(`/api/admin/questions/${b.dataset.qid}`, { method: 'POST', body: { action: b.dataset.act } }); route();
  });
};

// ---------- router
const PUBLIC = new Set(['', 'landing', 'login', 'signup', 'plans']);
async function route() {
  const [pathPart, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = pathPart.split('/').map(decodeURIComponent);
  const name = parts[0] || '';
  const query = new URLSearchParams(qs || '');
  if (!state.user && !PUBLIC.has(name)) { location.hash = '#/login'; return; }
  if (state.user && (name === '' || name === 'login' || name === 'signup' || name === 'landing')) { location.hash = '#/home'; return; }
  chrome();
  const view = views[name || 'landing'];
  if (!view) { location.hash = state.user ? '#/home' : '#/'; return; }
  try { await view(parts[1], parts[2], query); }
  catch (e) {
    if (e.status === 401) { state.user = null; location.hash = '#/login'; return; }
    render(`<div class="card center"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" data-reload>Reload</button></div>`);
  }
  chrome();
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-reload]')) location.reload(); });

async function boot() {
  try {
    const [meta] = await Promise.all([api('/api/meta'), refreshMe()]);
    state.meta = meta;
  } catch (e) {
    render(`<div class="card center"><h2>Cannot connect</h2><p>Check your internet connection and try again.</p><button class="btn" data-reload>Retry</button></div>`);
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
boot();
