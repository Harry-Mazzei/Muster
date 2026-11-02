'use strict';
/* Muster web mode.
   When Muster is opened from the web (GitHub Pages) there is no local server, so this file stands in for it:
   - Parades, settings and beat data are kept in your Firebase account. Google sign-in is required, and the
     Firestore security rules (firestore.rules) only let the owner's Google account read or write anything.
   - Music files stay in this browser (IndexedDB). They are never uploaded anywhere.
   When Muster is run from its folder on a laptop (localhost), none of this is used. */

const WEB = !['localhost', '127.0.0.1'].includes(location.hostname) || /[?&]web\b/.test(location.search);

const Cloud = WEB ? (() => {
  const TEST = /[?&]web=test\b/.test(location.search) && ['localhost', '127.0.0.1'].includes(location.hostname);
  const AUDIO = /\.(m4a|mp3|wav|aac|flac|ogg|oga|opus)$/i;
  const ID = /^[0-9a-f]{8,32}$/;
  const CATS = [
    [/salute|point of war|schedule/i, 'Salutes'], [/advance australia fair|god save|anthem/i, 'National Anthems'],
    [/drum/i, 'Drums'], [/slow to quick|dignified occasion/i, 'Slow to Quick Time'],
    [/slow march|scipio|duke of york|golden spurs|preobrajensky/i, 'Slow March'], [/advance in rev/i, 'Advance in Review Order'],
    [/march/i, 'Quick March'], [/reveille|alert|carry on|long g|last post|lights out|rouse|retreat|bugle/i, 'Bugle Calls'],
    [/hymn|abide with me|sunset|eternal father/i, 'Hymns & Sunset'],
  ];
  const VERSION = '1.1.0';
  let remote = null, user = null;
  const tracks = new Map(), parades = new Map();
  let settings = null, have = new Set();
  const builtin = new Map(); // id -> file name, for music published with the site (tracks/ folder)

  // ---------- helpers (same rules as the local server) ----------
  const clip = (s, n) => Array.from(String(s ?? '').trim()).slice(0, n).join('');
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const cleanTimes = (v, max) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === 'number' && x >= 0 && isFinite(x) && (!(max > 0) || x <= max + 1))
    .map((x) => Math.round(x * 1000) / 1000).sort((a, b) => a - b).slice(0, 20000);
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  async function trackId(file) {
    const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(file.toLowerCase()));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  }
  function guess(id, file) {
    const base = file.replace(/\.[^.]+$/, '');
    const m = base.match(/^(\d+)[\s._-]+(.*)$/);
    const title = (m ? m[2] : base).replace(/_/g, ' ').trim();
    const cat = CATS.find(([re]) => re.test(title))?.[1] || 'Other';
    return { id, file, title, category: cat, order: m ? parseInt(m[1], 10) : 1000, duration: 0, bpm: 0, bpm2: 0, change: 0, av: 0,
      trimStart: 0, trimEnd: 0, trimSet: false, beats: [], points: [], confidence: 0, gain: 1, analysed: false, checked: false };
  }
  const defaults = () => ({ theme: 'system', fadeSeconds: 5, offsetMs: 0, volume: 1, beatFlash: true, lastParade: '', favourites: [] });
  function sanitiseSettings(v) {
    const s = { ...defaults(), ...(v || {}) };
    if (!['day', 'night', 'system'].includes(s.theme)) s.theme = 'system';
    if (!(s.fadeSeconds >= 0.5 && s.fadeSeconds <= 30)) s.fadeSeconds = 5;
    if (!(s.offsetMs >= -500 && s.offsetMs <= 500)) s.offsetMs = 0;
    if (!(s.volume >= 0 && s.volume <= 1)) s.volume = 1;
    s.beatFlash = !!s.beatFlash;
    s.favourites = [...new Set((s.favourites || []).filter((x) => ID.test(x)))].slice(0, 9);
    if (s.lastParade && !ID.test(s.lastParade)) s.lastParade = '';
    return { theme: s.theme, fadeSeconds: s.fadeSeconds, offsetMs: s.offsetMs, volume: s.volume, beatFlash: s.beatFlash, lastParade: s.lastParade, favourites: s.favourites };
  }
  function sanitiseParade(p, id) {
    const items = Array.isArray(p.items) ? p.items : [];
    if (items.length > 500) throw new Error('A parade can hold at most 500 movements.');
    const out = { id, name: clip(p.name, 100) || 'Untitled parade', notes: clip(p.notes, 2000), created: '', updated: '', items: [] };
    items.forEach((it, i) => {
      if (!ID.test(it.trackId || '')) throw new Error(`Movement ${i + 1} has no music selected.`);
      out.items.push({ uid: ID.test(it.uid || '') ? it.uid : newId(), trackId: it.trackId, label: clip(it.label, 120), cue: clip(it.cue, 500),
        loop: !!it.loop, auto: !!it.auto, transition: it.transition === 'now' ? 'now' : 'beat' });
    });
    return out;
  }
  const strip = (t) => { const { missing, ...rest } = t; return rest; };
  const withMissing = (t) => ({ ...t, missing: !have.has(t.id) && !builtin.has(t.id) });
  function library() {
    return [...tracks.values()].map(withMissing).sort((a, b) => (a.order - b.order) || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  }
  const summaries = () => [...parades.values()].map((p) => ({ id: p.id, name: p.name, updated: p.updated, count: p.items.length }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  // Writes go to the local copy straight away and reach the account in the background (works offline too).
  const later = (p) => p.catch((e) => toast(e?.code === 'permission-denied' ? 'This account is not allowed to change Muster.' : 'Not saved to your account yet: ' + (e?.message || e), true));

  // ---------- music kept in this browser ----------
  const idb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('muster-music', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction('files', mode), req = fn(tx.objectStore('files'));
        tx.oncomplete = () => res(req?.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Storage full?'));
      });
    };
    return {
      put: (rec) => run('readwrite', (s) => s.put(rec)),
      get: (id) => run('readonly', (s) => s.get(id)),
      keys: () => run('readonly', (s) => s.getAllKeys()),
    };
  })();

  // ---------- account storage: Firestore (real) or this browser only (local test mode) ----------
  async function firestore(fb, app, uid) {
    const db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
    const ref = (p) => fb.doc(db, `users/${uid}/${p}`);
    const quick = (server, cache) => Promise.race([server(), new Promise((_, rej) => setTimeout(() => rej(new Error('offline')), 5000))])
      .catch((e) => { if (e?.code === 'permission-denied') throw e; return cache(); });
    return {
      async get(p) { const d = await quick(() => fb.getDocFromServer(ref(p)), () => fb.getDocFromCache(ref(p)).catch(() => null)); return d?.exists() ? d.data() : null; },
      async list(c) {
        const q = fb.collection(db, `users/${uid}/${c}`);
        const s = await quick(() => fb.getDocsFromServer(q), () => fb.getDocsFromCache(q));
        return s.docs.map((d) => d.data());
      },
      set: (p, v) => fb.setDoc(ref(p), JSON.parse(JSON.stringify(v))),
      del: (p) => fb.deleteDoc(ref(p)),
      async setMany(list) { // batches of 400 (Firestore allows 500 per batch)
        for (let i = 0; i < list.length; i += 400) {
          const b = fb.writeBatch(db);
          list.slice(i, i + 400).forEach(([p, v]) => b.set(ref(p), JSON.parse(JSON.stringify(v))));
          await b.commit();
        }
      },
    };
  }
  function testStore() {
    const k = (p) => 'muster-test:' + p;
    const all = () => Object.keys(localStorage).filter((x) => x.startsWith('muster-test:'));
    return {
      async get(p) { const v = localStorage.getItem(k(p)); return v ? JSON.parse(v) : null; },
      async list(c) { return all().filter((x) => x.startsWith(k(c + '/'))).map((x) => JSON.parse(localStorage.getItem(x))); },
      async set(p, v) { localStorage.setItem(k(p), JSON.stringify(v)); },
      async del(p) { localStorage.removeItem(k(p)); },
      async setMany(list) { list.forEach(([p, v]) => localStorage.setItem(k(p), JSON.stringify(v))); },
    };
  }

  // ---------- sign in ----------
  const gate = (msg, btn, hint) => {
    $('#gate').hidden = false;
    $('#gateMsg').textContent = msg;
    $('#gateBtn').hidden = !btn; if (btn) $('#gateBtn').textContent = btn;
    $('#gateHint').textContent = hint || '';
  };
  async function start() {
    if (TEST) {
      gate('Local test mode. Nothing leaves this browser.', 'Sign in (test)');
      await new Promise((r) => { $('#gateBtn').onclick = r; });
      user = { email: 'test@localhost', name: 'Test' }; remote = testStore();
    } else {
      const cfg = window.MUSTER_FIREBASE;
      if (!cfg || !cfg.apiKey) { gate('Muster is not connected to an account yet.', null, 'Add your Firebase settings to firebase-config.js (see SETUP.md).'); await new Promise(() => {}); }
      gate('Checking sign-in…');
      const fb = await import('./vendor/firebase.js');
      const app = fb.initializeApp(cfg);
      const auth = fb.getAuth(app);
      fb.getRedirectResult(auth).catch(() => {});
      const u = await new Promise((r) => { const off = fb.onAuthStateChanged(auth, (x) => { off(); r(x); }); });
      let signed = u;
      while (!signed) {
        gate('Parade music console. Sign in to continue.', 'Sign in with Google');
        await new Promise((r) => { $('#gateBtn').onclick = r; });
        const provider = new fb.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try { signed = (await fb.signInWithPopup(auth, provider)).user; }
        catch (e) {
          if (e?.code === 'auth/popup-blocked') { await fb.signInWithRedirect(auth, provider); return new Promise(() => {}); }
          if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') toast('Sign-in failed: ' + (e?.message || e), true);
        }
      }
      user = { email: signed.email, name: signed.displayName || signed.email };
      Cloud.signOut = async () => { await fb.signOut(auth); location.reload(); };
      gate('Opening your parades…');
      remote = await firestore(fb, app, signed.uid);
      try { await remote.get('meta/settings'); }
      catch (e) {
        if (e?.code !== 'permission-denied') throw e;
        gate(`${signed.email} is not allowed to use this Muster.`, 'Use a different account');
        await new Promise((r) => { $('#gateBtn').onclick = r; });
        await fb.signOut(auth); location.reload(); return new Promise(() => {});
      }
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    await refresh();
    $('#gate').hidden = true;
    if ('serviceWorker' in navigator && !TEST) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  async function refresh() {
    const [s, ts, ps, keys] = await Promise.all([remote.get('meta/settings'), remote.list('tracks'), remote.list('parades'), idb.keys()]);
    settings = sanitiseSettings(s);
    tracks.clear(); ts.forEach((t) => t?.id && tracks.set(t.id, t));
    parades.clear(); ps.forEach((p) => p?.id && parades.set(p.id, p));
    have = new Set(keys);
    await loadBuiltin();
  }
  // Music published with the site: tracks/index.json is made by the GitHub workflow from the repo's tracks/ folder.
  async function loadBuiltin() {
    let list = [];
    try { const r = await fetch('tracks/index.json', { cache: 'no-cache' }); if (r.ok) list = await r.json(); } catch { /* offline: use what is cached */ }
    if (!Array.isArray(list)) return;
    const fresh = [];
    for (const x of list) {
      const file = typeof x === 'string' ? x : x?.file;
      if (!file || !AUDIO.test(file) || file.includes('/')) continue;
      const id = await trackId(file);
      builtin.set(id, file);
      if (!tracks.has(id)) { const t = guess(id, file); tracks.set(id, t); fresh.push(['tracks/' + id, t]); }
    }
    if (fresh.length) later(remote.setMany(fresh));
  }

  // ---------- the same API the local server offers ----------
  async function api(method, url, body) {
    const path = url.replace(/\?.*$/, '');
    let m;
    if (method === 'GET' && path === '/api/state') {
      await refresh();
      return { version: VERSION, settings, library: library(), parades: summaries(), musicDir: 'this browser' };
    }
    if (method === 'POST' && path === '/api/rescan') { have = new Set(await idb.keys()); return { added: 0, library: library() }; }
    if (method === 'POST' && path === '/api/music') return importMusic(body.getAll('files'));
    if (method === 'PATCH' && (m = path.match(/^\/api\/tracks\/([0-9a-f]+)$/))) return patchTrack(m[1], body || {});
    if (method === 'PUT' && path === '/api/settings') { settings = sanitiseSettings(body); later(remote.set('meta/settings', settings)); return settings; }
    if (method === 'POST' && path === '/api/parades') return saveParade(body, newId());
    if ((m = path.match(/^\/api\/parades\/([0-9a-f]{8,32})$/))) {
      const id = m[1];
      if (method === 'GET') { const p = parades.get(id) || (await remote.get('parades/' + id)); if (!p) throw new Error('not found'); return structuredClone(p); }
      if (method === 'PUT') return saveParade(body, id);
      if (method === 'DELETE') { if (!parades.delete(id)) throw new Error('not found'); later(remote.del('parades/' + id)); return { ok: true }; }
    }
    if (method === 'POST' && path === '/api/restore') return restore(body);
    throw new Error('Not available in the web version.');
  }
  function saveParade(p, id) {
    const out = sanitiseParade(p || {}, id), old = parades.get(id), now = new Date().toISOString();
    out.created = old?.created || now; out.updated = now;
    parades.set(id, out);
    later(remote.set('parades/' + id, out));
    return structuredClone(out);
  }
  function patchTrack(id, p) {
    const t = tracks.get(id);
    if (!t) throw new Error('not found');
    const n = { ...t };
    if (p.title != null && clip(p.title, 120)) n.title = clip(p.title, 120);
    if (p.category != null && clip(p.category, 60)) n.category = clip(p.category, 60);
    if (p.duration > 0 && p.duration < 36000) n.duration = p.duration;
    for (const k of ['bpm', 'bpm2']) if (p[k] >= 0 && p[k] < 400) n[k] = p[k];
    if (p.change >= 0) n.change = p.change;
    if (Number.isInteger(p.av)) n.av = p.av;
    if (p.trimStart != null || p.trimEnd != null) {
      const ts = p.trimStart ?? n.trimStart, te = p.trimEnd ?? n.trimEnd;
      if (ts < 0 || te < 0 || (te > 0 && te < ts + 0.2) || (n.duration > 0 && (ts > n.duration || te > n.duration + 1))) throw new Error("Those start and end points don't fit this track.");
      n.trimStart = ts; n.trimEnd = te;
    }
    for (const k of ['trimSet', 'analysed', 'checked']) if (typeof p[k] === 'boolean') n[k] = p[k];
    if (p.beats) n.beats = cleanTimes(p.beats, n.duration);
    if (p.points) n.points = cleanTimes(p.points, n.duration);
    if (typeof p.confidence === 'number') n.confidence = num(p.confidence);
    if (p.gain >= 0 && p.gain <= 4) n.gain = p.gain;
    tracks.set(id, n);
    later(remote.set('tracks/' + id, n));
    return withMissing(n);
  }
  async function importMusic(files) {
    const saved = [], problems = [], fresh = [];
    for (const f of files) {
      const name = f.name.split(/[\\/]/).pop();
      if (name.startsWith('.')) continue;
      if (!AUDIO.test(name)) { if (!/\.(jpe?g|png|gif|txt|pdf|ds_store|ini|db)$/i.test(name)) problems.push(`${name} is not a supported audio file (m4a, mp3, wav, aac, flac, ogg)`); continue; }
      const id = await trackId(name);
      try { await idb.put({ id, file: name, type: f.type, size: f.size, blob: f }); }
      catch (e) { problems.push(`${name} could not be stored in this browser (${e?.message || 'out of space?'})`); continue; }
      have.add(id); saved.push(name);
      if (!tracks.has(id)) { const t = guess(id, name); tracks.set(id, t); fresh.push(['tracks/' + id, t]); }
    }
    if (fresh.length) later(remote.setMany(fresh));
    return { saved, problems, library: library() };
  }
  async function audio(id) {
    const r = await idb.get(id);
    if (r) return r.blob.arrayBuffer();
    const file = builtin.get(id);
    if (!file) throw new Error('This music is not on this laptop yet. Choose your music folder on the Music page.');
    let res;
    try { res = await fetch('tracks/' + encodeURIComponent(file)); } catch { res = null; }
    if (!res?.ok) throw new Error(`Could not download ${file}. Check the internet connection.`);
    const blob = await res.blob();
    // keep a copy in this browser so it plays offline next time
    idb.put({ id, file, type: blob.type, size: blob.size, blob }).then(() => have.add(id)).catch(() => {});
    return blob.arrayBuffer();
  }
  function exportAll() {
    return { app: 'muster', version: VERSION, exported: new Date().toISOString(), settings, library: [...tracks.values()].map(strip), parades: [...parades.values()] };
  }
  async function restore(b) {
    if (b?.app !== 'muster') throw new Error('This file is not a Muster backup or parade file.');
    const writes = [];
    let np = 0, nt = 0;
    for (const p of b.parades || []) {
      const id = ID.test(p.id || '') ? p.id : newId();
      let out;
      try { out = sanitiseParade(p, id); } catch (e) { throw new Error(`Parade “${p.name}”: ${e.message}`); }
      const now = new Date().toISOString();
      out.created = p.created || parades.get(id)?.created || now; out.updated = now;
      parades.set(id, out); writes.push(['parades/' + id, out]); np++;
    }
    if (b.settings) { settings = sanitiseSettings(b.settings); writes.push(['meta/settings', settings]); }
    for (const t of b.library || []) {
      if (!t?.file || !AUDIO.test(t.file)) continue;
      const id = await trackId(t.file), base = tracks.get(id) || guess(id, t.file);
      const n = { ...base, title: clip(t.title, 120) || base.title, category: clip(t.category, 60) || base.category, order: Number.isInteger(t.order) ? t.order : base.order,
        duration: num(t.duration) || base.duration, bpm: num(t.bpm), bpm2: num(t.bpm2), change: num(t.change), av: t.av | 0,
        trimStart: num(t.trimStart), trimEnd: num(t.trimEnd), trimSet: !!t.trimSet, beats: cleanTimes(t.beats, 0), points: cleanTimes(t.points, 0),
        confidence: num(t.confidence), gain: t.gain >= 0 && t.gain <= 4 ? t.gain : 1, analysed: !!t.analysed, checked: !!t.checked };
      tracks.set(id, n); writes.push(['tracks/' + id, n]); nt++;
    }
    later(remote.setMany(writes));
    return { message: `Restored ${np} parade(s) and details for ${nt} track(s).` };
  }

  return { start, api, audio, exportAll, user: () => user, signOut: async () => location.reload(), test: TEST };
})() : null;
