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
  // Same rules as the laptop app's prepared library (tools/analyze.js), plus general ones for other music.
  const CATS = [
    [/salute|point of war|schedule/i, 'Salutes'], [/advance australia fair|god save|anthem/i, 'National Anthems'],
    [/drum/i, 'Drums'], [/slow to quick|dignified occasion/i, 'Slow to Quick Time'],
    [/slow march|scipio|duke of york|golden spurs|preobrajensky/i, 'Slow March'], [/advance in rev/i, 'Advance in Review Order'],
    [/moray|great little army|invercargill|officer of the day|holyrood|step off/i, 'Step Off'],
    [/infantry song|greensleeves|inspection/i, 'Inspection'],
    [/march|jollies|glorious victory|waltzing matilda|national emblem|army of the nile/i, 'Quick March'],
    [/reveille|alert|carry on|long g|last post|lights out|rouse|retreat|bugle/i, 'Bugle Calls'],
    [/hymn|abide with me|sunset|eternal father/i, 'Hymns & Sunset'], [/dress/i, 'Drill Commands'],
  ];
  const TITLE_FIX = {
    'Advance Australia Fair (Instrumen': 'Advance Australia Fair (Instrumental)', 'Advance In Revew Order - Navy': 'Advance in Review Order - Navy',
    'Advance In Review Order - Army': 'Advance in Review Order - Army', 'Advance In Review Order - RAAF': 'Advance in Review Order - RAAF',
    'The Moray Fifth': 'The Moray Firth', 'Reveille_Rouse': 'Reveille & Rouse', 'Reveille Rouse': 'Reveille & Rouse',
    'Slow To Quick - RAAF': 'Slow to Quick - RAAF', 'March past': 'March Past',
  };
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
    const raw = (m ? m[2] : base).trim();
    const title = TITLE_FIX[raw] || raw.replace(/_/g, ' ').trim();
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
  // Saves in this browser only (guest mode and local test mode)
  function localStore(prefix) {
    const k = (p) => prefix + p;
    const all = () => Object.keys(localStorage).filter((x) => x.startsWith(prefix));
    return {
      async get(p) { const v = localStorage.getItem(k(p)); return v ? JSON.parse(v) : null; },
      async list(c) { return all().filter((x) => x.startsWith(k(c + '/'))).map((x) => JSON.parse(localStorage.getItem(x))); },
      async set(p, v) { localStorage.setItem(k(p), JSON.stringify(v)); },
      async del(p) { localStorage.removeItem(k(p)); },
      async setMany(list) { list.forEach(([p, v]) => localStorage.setItem(k(p), JSON.stringify(v))); },
    };
  }

  // ---------- sign in ----------
  const gate = (msg, btn, hint, alt) => {
    $('#gate').hidden = false;
    $('#gateMsg').textContent = msg;
    $('#gateBtn').hidden = !btn; if (btn) $('#gateBtn').textContent = btn;
    $('#gateHint').textContent = hint || '';
    $('#gateAlt').hidden = !alt; if (alt) $('#gateAlt').textContent = alt;
    $('#gateForm').hidden = true;
    $('#gGuest').hidden = true;
  };
  // Guest mode: no account, everything saved in this browser only. Never touches the owner's data.
  const GUEST = { guest: true };
  const offerGuest = (resolve) => { $('#gGuest').hidden = false; $('#gGuest').onclick = () => resolve(GUEST); };
  async function enterGuest() {
    try { localStorage.setItem('muster-mode', 'guest'); } catch {}
    user = { email: null, name: 'Guest', guest: true };
    remote = localStore('muster-guest:');
    Cloud.signOut = async () => { try { localStorage.removeItem('muster-mode'); } catch {} location.reload(); };
    await finish();
  }
  const say = (t) => { $('#gateHint').textContent = t; };
  const AUTH_ERR = {
    'auth/invalid-credential': 'Email or password is wrong.', 'auth/wrong-password': 'Email or password is wrong.',
    'auth/user-not-found': 'Email or password is wrong.', 'auth/invalid-email': 'That email address doesn’t look right.',
    'auth/missing-password': 'Type your password.', 'auth/weak-password': 'Use a password of at least 6 characters.',
    'auth/email-already-in-use': 'That email already has an account. Sign in instead, or use Google if that’s how you signed up.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/admin-restricted-operation': 'New accounts are switched off for this Muster.',
    'auth/operation-not-allowed': 'That sign-in method isn’t switched on in Firebase.',
    'auth/network-request-failed': 'No internet connection.',
  };
  const authMsg = (e) => AUTH_ERR[e?.code] || 'Sign-in failed: ' + (e?.message || e);
  // Resolves with a signed-in user (Google or email). Email accounts may still need verifying.
  function signInScreen(m) {
    return new Promise((resolve) => {
      gate('Parade music console. Sign in to continue.', 'Sign in with Google');
      $('#gateForm').hidden = false;
      offerGuest(resolve);
      const email = () => $('#gEmail').value.trim(), pass = () => $('#gPass').value;
      const busy = (on) => { for (const b of ['#gateBtn', '#gSignIn', '#gCreate', '#gReset']) $(b).disabled = on; };
      const attempt = async (fn) => { busy(true); try { const u = await fn(); if (u) resolve(u); } catch (e) { if (!/popup-closed|cancelled-popup/.test(e?.code || '')) say(authMsg(e)); } finally { busy(false); } };
      $('#gateBtn').onclick = () => attempt(m.google);
      $('#gateForm').onsubmit = (ev) => { ev.preventDefault(); if (!email() || !pass()) return say('Type your email and password.'); attempt(() => m.signIn(email(), pass())); };
      $('#gCreate').onclick = () => {
        if (!email() || pass().length < 6) return say('Type your email and a new password (at least 6 characters), then press Create account.');
        attempt(() => m.create(email(), pass()));
      };
      $('#gReset').onclick = () => {
        if (!email()) return say('Type your email above first, then press Forgot password.');
        attempt(async () => { await m.reset(email()); say(`If ${email()} has an account, a reset link is on its way. Check spam too.`); });
      };
    });
  }
  // Email accounts must confirm their address (the security rules only accept verified emails).
  async function verifyScreen(m, u) {
    try { await m.sendVerify(u); } catch (e) { if (e?.code !== 'auth/too-many-requests') toast(authMsg(e), true); }
    gate(`We sent a link to ${u.email}. Open it, then press Continue.`, 'Continue', 'No email? Check your spam folder.', 'Use a different account');
    return new Promise((resolve) => {
      $('#gateBtn').onclick = async () => {
        const ok = await m.checkVerified(u).catch(() => false);
        if (ok) resolve(ok); else say('Not verified yet. Open the link in the email first, then press Continue.');
      };
      $('#gateAlt').onclick = async () => { await m.signOut(); resolve(null); };
    });
  }
  async function signInLoop(m, u) {
    while (!u || !u.emailVerified) {
      if (!u) u = await signInScreen(m);
      if (u === GUEST) return u;
      if (u && !u.emailVerified) u = await verifyScreen(m, u);
    }
    return u;
  }
  async function start() {
    let mode = null;
    try { mode = localStorage.getItem('muster-mode'); } catch {}
    if (mode === 'guest') return enterGuest();
    if (TEST) {
      // local test mode only: pretend accounts, nothing leaves this browser
      const fake = (email, verified) => ({ email, displayName: email, uid: 'test', emailVerified: verified });
      const m = {
        google: async () => fake('test@localhost', true),
        signIn: async (e, p) => { if (p !== 'parade123') throw { code: 'auth/invalid-credential' }; return fake(e, localStorage.getItem('muster-test-verified') === e); },
        create: async (e) => fake(e, false),
        reset: async () => {},
        sendVerify: async () => {},
        checkVerified: async (u) => (localStorage.getItem('muster-test-verified') === u.email ? fake(u.email, true) : false),
        signOut: async () => {},
      };
      const u = await signInLoop(m, null);
      if (u === GUEST) return enterGuest();
      user = { email: u.email, name: u.email }; remote = localStore('muster-test:');
    } else {
      const cfg = window.MUSTER_FIREBASE;
      if (!cfg || !cfg.apiKey) {
        gate('Muster is not connected to an account yet.', null, 'Add your Firebase settings to firebase-config.js (see SETUP.md).');
        await new Promise((r) => offerGuest(r));
        return enterGuest();
      }
      gate('Checking sign-in…');
      const fb = await import('./vendor/firebase.js');
      const app = fb.initializeApp(cfg);
      const auth = fb.getAuth(app);
      fb.getRedirectResult(auth).catch(() => {});
      const provider = new fb.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const m = {
        async google() {
          try { return (await fb.signInWithPopup(auth, provider)).user; }
          catch (e) { if (e?.code === 'auth/popup-blocked') { await fb.signInWithRedirect(auth, provider); return new Promise(() => {}); } throw e; }
        },
        signIn: async (e, p) => (await fb.signInWithEmailAndPassword(auth, e, p)).user,
        create: async (e, p) => (await fb.createUserWithEmailAndPassword(auth, e, p)).user,
        reset: (e) => fb.sendPasswordResetEmail(auth, e),
        sendVerify: (u) => fb.sendEmailVerification(u),
        async checkVerified(u) { await u.reload(); const c = auth.currentUser; if (!c?.emailVerified) return false; await c.getIdToken(true); return c; },
        signOut: () => fb.signOut(auth),
      };
      const u0 = await new Promise((r) => { const off = fb.onAuthStateChanged(auth, (x) => { off(); r(x); }); });
      const signed = await signInLoop(m, u0);
      if (signed === GUEST) return enterGuest();
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
    await finish();
  }
  async function finish() {
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
    regroup();
  }
  // Tracks the older rules put in "Other": give them the right category and detect their beats.
  function regroup() {
    const fixes = [];
    for (const t of tracks.values()) {
      if (t.category !== 'Other' || t.checked || t.points?.length) continue;
      const g = guess(t.id, t.file);
      if (g.category === 'Other') continue;
      const n = { ...t, category: g.category, analysed: false };
      const m = t.file.replace(/\.[^.]+$/, '').match(/^(\d+)[\s._-]+(.*)$/);
      const oldTitle = (m ? m[2] : t.file.replace(/\.[^.]+$/, '')).replace(/_/g, ' ').trim();
      if (t.title === oldTitle) n.title = g.title; // only if it was never renamed by hand
      tracks.set(t.id, n); fixes.push(['tracks/' + t.id, n]);
    }
    if (fixes.length) later(remote.setMany(fixes));
  }
  // Music published with the site: tracks/index.json is made by the GitHub workflow from the repo's tracks/ folder.
  async function loadBuiltin() {
    let list = [];
    try { const r = await fetch('tracks/index.json', { cache: 'no-cache' }); if (r.ok) list = await r.json(); } catch { /* offline: use what is cached */ }
    if (!Array.isArray(list)) return;
    // tracks/presets.json: categories, trim and beat points worked out by the GitHub workflow (tools/analyze.js)
    let presets = {};
    try { const r = await fetch('tracks/presets.json', { cache: 'no-cache' }); if (r.ok) presets = (await r.json()) || {}; } catch { /* none yet */ }
    const fresh = [];
    for (const x of list) {
      const file = typeof x === 'string' ? x : x?.file;
      if (!file || !AUDIO.test(file) || file.includes('/')) continue;
      const id = await trackId(file);
      builtin.set(id, file);
      const p = presets[file], t = tracks.get(id);
      if (!t) { const n = p ? fromPreset(id, file, p) : guess(id, file); tracks.set(id, n); fresh.push(['tracks/' + id, n]); continue; }
      const n = p && upgrade(t, p);
      if (n) { tracks.set(id, n); fresh.push(['tracks/' + id, n]); }
    }
    if (fresh.length) later(remote.setMany(fresh));
  }
  function fromPreset(id, file, p) {
    const g = guess(id, file);
    return { ...g, title: clip(p.title, 120) || g.title, category: clip(p.category, 60) || g.category, order: Number.isInteger(p.order) ? p.order : g.order,
      duration: num(p.duration), trimStart: num(p.trimStart), trimEnd: num(p.trimEnd), bpm: num(p.bpm), bpm2: num(p.bpm2), change: num(p.change),
      av: p.av | 0, beats: cleanTimes(p.beats, 0), points: cleanTimes(p.points, 0), confidence: num(p.confidence), analysed: true };
  }
  // Newer prepared data fills in what a track is missing; anything set by hand is never overwritten.
  function upgrade(t, p) {
    const n = { ...t };
    let changed = false;
    if (!t.trimEnd && !t.trimSet && p.trimEnd > 0) { n.trimStart = num(p.trimStart); n.trimEnd = num(p.trimEnd); changed = true; }
    if ((p.av | 0) > (t.av | 0) && !t.checked) {
      Object.assign(n, { bpm: num(p.bpm), bpm2: num(p.bpm2), change: num(p.change), confidence: num(p.confidence), av: p.av | 0,
        beats: cleanTimes(p.beats, 0), points: cleanTimes(p.points, 0) });
      changed = true;
    }
    if (t.category === 'Other' && p.category && p.category !== 'Other') {
      n.category = clip(p.category, 60);
      const g = guess(t.id, t.file), plain = g.title.replace(/_/g, ' ');
      if (t.title === plain || t.title === t.file.replace(/^\d+[\s._-]+/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()) n.title = clip(p.title, 120) || t.title;
      changed = true;
    }
    if (!changed) return null;
    if (!n.duration && p.duration) n.duration = num(p.duration);
    n.analysed = true;
    return n;
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
