/* Stands in for Claude's artifact runtime (claude.use) so the Hub runs as a normal website. */
(function () {
  'use strict';
  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) { location.href = '/login'; throw { code: 'revoked', message: 'Signed out' }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 403 ? 'invalid_argument' : (j.code || (r.status >= 500 ? 'unavailable' : 'invalid_argument')), message: j.error || ('HTTP ' + r.status) };
    return j;
  }
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const docSnap = (id, exists, data) => ({ id, exists, data: () => (exists ? data : undefined), metadata: META });
  const rid = () => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; const b = crypto.getRandomValues(new Uint8Array(20)); for (const x of b) s += a[x % 62]; return s; };

  // ---- change feed ----
  const listeners = new Set();
  function startFeed() {
    let es;
    const open = () => {
      es = new EventSource('/api/events');
      es.onmessage = e => { let paths; try { paths = JSON.parse(e.data); } catch (_) { return; } listeners.forEach(l => l(paths)); };
      es.onerror = () => { es.close(); setTimeout(open, 3000); };
    };
    open();
    setInterval(() => listeners.forEach(l => l(['*'])), 30000);
  }

  function docRef(path) {
    const segs = path.split('/');
    if (segs.length % 2) throw new TypeError('Document path needs an even number of segments: ' + path);
    const id = segs[segs.length - 1];
    return {
      id, path,
      async get() { const j = await api('GET', '/api/doc?path=' + encodeURIComponent(path)); return docSnap(id, j.exists, j.data); },
      async set(data) { await api('PUT', '/api/doc', { path, data }); },
      async update(data) { await api('PATCH', '/api/doc', { path, data }); },
      async delete() { await api('DELETE', '/api/doc?path=' + encodeURIComponent(path)); },
      async acquire() { return { acquired: true }; },
      collection(sub) { return collRef(path + '/' + sub); },
      onSnapshot(next, error) {
        let alive = true, last = null;
        const pull = () => this.get().then(s => { if (!alive) return; const k = JSON.stringify([s.exists, s.data()]); if (k !== last) { last = k; next(s); } }).catch(e => { if (alive && error && e && e.code === 'revoked') { alive = false; error(e); } });
        const l = paths => { if (paths.includes('*') || paths.includes(path)) pull(); };
        listeners.add(l); pull();
        return () => { alive = false; listeners.delete(l); };
      },
    };
  }
  function query(coll, where, orderBy, dir, lim) {
    const q = {
      where(field, op, value) { return query(coll, where.concat([{ field, op, value }]), orderBy, dir, lim); },
      orderBy(f, d) { return query(coll, where, f, d || 'asc', lim); },
      limit(n) { return query(coll, where, orderBy, dir, n); },
      async get() {
        const j = await api('POST', '/api/query', { coll, where, orderBy, dir, limit: lim });
        const docs = j.docs.map(d => docSnap(d.id, true, d.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), metadata: META };
      },
      onSnapshot(next, error) {
        let alive = true, last = null;
        const pull = () => q.get().then(s => { if (!alive) return; const k = JSON.stringify(s.docs.map(d => [d.id, d.data()])); if (k !== last) { last = k; next(s); } }).catch(e => { if (alive && error && e && e.code === 'revoked') { alive = false; error(e); } });
        const l = paths => { if (paths.includes('*') || paths.some(p => p.split('/').slice(0, -1).join('/') === coll)) pull(); };
        listeners.add(l); pull();
        return () => { alive = false; listeners.delete(l); };
      },
    };
    return q;
  }
  function collRef(path) {
    if (path.split('/').length % 2 === 0) throw new TypeError('Collection path needs an odd number of segments: ' + path);
    return Object.assign(query(path, [], null, 'asc', null), {
      path,
      doc(id) { return docRef(path + '/' + (id || rid())); },
      async add(data) { const r = docRef(path + '/' + rid()); await r.set(data); return r; },
    });
  }

  let me = null; const profCache = {};
  const ready = api('GET', '/api/me').then(u => { me = u; return u; });
  const canW = () => !!me && (me.role === 'admin' || me.role === 'editor');
  const db = Object.freeze({ doc: docRef, collection: collRef });
  const user = Object.freeze({
    async id() { await ready; return me ? String(me.id) : null; },
    async name() { await ready; return me ? me.name : null; },
    async profiles(ids) {
      ids = (ids || []).map(String); const need = ids.filter(i => !(i in profCache));
      if (need.length) { const r = await api('GET', '/api/profiles?ids=' + encodeURIComponent(need.join(','))); need.forEach(i => { profCache[i] = r[i] || (/^\d+$/.test(i) ? null : { name: 'Claude Hub' }); }); }
      const out = {}; ids.forEach(i => { if (profCache[i]) out[i] = profCache[i]; }); return out;
    },
    async canEdit() { await ready; return canW(); },
    async can(what) { await ready; return what === 'data.write' ? canW() : null; },
    async isOwner() { await ready; return !!me && me.role === 'admin'; },
  });
  const assets = Object.freeze({
    async upload(file) {
      const r = await fetch('/api/assets?name=' + encodeURIComponent(file.name || 'file'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) throw { code: 'unavailable', message: 'Upload failed' };
      return r.json();
    },
  });
  const caps = { db, user, assets, downloads: null, mcp: null };
  window.claude = Object.freeze({
    use(name) {
      if (!(name in caps) || !caps[name]) return Promise.resolve(null);
      return ready.then(() => caps[name]).catch(() => null);
    },
  });
  startFeed();

  // account bar
  ready.then(u => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:7px;right:104px;z-index:50;display:flex;gap:10px;align-items:center;font:13px Calibri,Carlito,Segoe UI,Arial,sans-serif;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:999px;padding:5px 12px;box-shadow:0 1px 4px rgba(0,0,0,.08)';
    const roleTxt = { admin: 'Admin', editor: 'Editor', viewer: 'View only' }[u.role] || u.role;
    bar.innerHTML = '<span><b></b> · <span style="color:var(--ink-muted,#666)"></span></span>' +
      (u.role === 'admin' ? '<a href="/admin" style="color:var(--red-ink,#b3261e)">Users &amp; data</a>' : '') +
      '<a href="#" id="hubLogout" style="color:var(--red-ink,#b3261e)">Sign out</a>';
    bar.querySelector('b').textContent = u.name;
    bar.querySelector('span span').textContent = roleTxt;
    const add = () => document.body.appendChild(bar);
    document.body ? add() : document.addEventListener('DOMContentLoaded', add);
    bar.querySelector('#hubLogout').onclick = async e => { e.preventDefault(); await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };
  }).catch(() => {});
})();
