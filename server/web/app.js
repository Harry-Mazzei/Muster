'use strict';
/* Muster frontend. Sections: helpers · API · state · audio engine · Run · Parades · Music · Settings · keys · boot */

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

function toast(msg, bad) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}
// two-click confirm for destructive buttons
function confirmClick(btn, label, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.classList.remove('arm'); btn.textContent = btn.dataset.orig; fn(); return; }
  btn.dataset.orig = btn.textContent; btn.dataset.armed = '1'; btn.classList.add('arm'); btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.classList.remove('arm'); btn.textContent = btn.dataset.orig; } }, 3500);
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- API ----------
// Safari can fail a request on a stale connection ("Load failed"); retry quickly.
async function fetchRetry(url, opt, tries) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, opt); }
    catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 120 * (i + 1))); }
  }
}
async function api(method, url, body) {
  if (WEB) return Cloud.api(method, url, body);
  const opt = { method, headers: { 'X-Muster': '1' } };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetchRetry(url, opt, method === 'GET' ? 2 : 0); } catch { throw new Error('Muster is not running. Start it again from its folder.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ---------- state ----------
const PRIOR = { 'Quick March': 116, 'Step Off': 116, 'Advance in Review Order': 112, 'Inspection': 100, 'Slow March': 66, 'Slow to Quick Time': 70 };
const CAT_ORDER = ['National Anthems', 'Salutes', 'Drums', 'Drill Commands', 'Quick March', 'Step Off', 'Advance in Review Order', 'Inspection', 'Slow March', 'Slow to Quick Time', 'Bugle Calls', 'Hymns & Sunset'];
const App = {
  settings: {}, library: [], byId: new Map(), parades: [], loaded: null, editing: null, view: 'run', version: '', musicDir: '',
  setLibrary(lib) { lib.forEach((t) => { t.points ||= []; t.beats ||= []; }); this.library = lib; this.byId = new Map(lib.map((t) => [t.id, t])); },
  track(id) { return this.byId.get(id); },
  categories() {
    const cats = [...new Set(this.library.map((t) => t.category))];
    return cats.sort((a, b) => ((CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  },
};
// Trim: where a track really starts and ends (silence cut off). Times stay in track seconds.
function trimOf(t, raw) {
  const d = t?.duration || 0;
  if (raw || !t) return [0, d];
  const s = clamp(t.trimStart || 0, 0, d || Infinity);
  const e = t.trimEnd > s + 0.2 ? (d ? Math.min(t.trimEnd, d) : t.trimEnd) : d;
  return [s, e];
}
const tlen = (t) => { const [s, e] = trimOf(t); return e - s; };
const label = (item) => item.label || App.track(item.trackId)?.title || 'Missing music';

// ---------- audio engine ----------
const Engine = {
  ctx: null, master: null, cache: new Map(), cacheBytes: 0, busy: false,
  cur: null, pending: null, armedUid: null, interrupted: null, played: new Set(), wake: null,
  onchange: () => {},

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = App.settings.volume ?? 1;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  },
  async unlock() {
    this.ensure();
    if (this.ctx.state === 'running') return;
    // After sleep Safari can leave the context "interrupted", where resume() never settles. Don't wait forever.
    await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 700))]);
    if (this.ctx.state !== 'running') { recoverAudio(false); await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 700))]); }
  },
  now() { return this.ctx.currentTime; },

  load(id) {
    this.ensure();
    let e = this.cache.get(id);
    if (e) { e.used = performance.now(); return e.p; }
    e = { used: performance.now(), bytes: 0 };
    e.p = (WEB ? Cloud.audio(id) : fetchRetry('/audio/' + id, undefined, 3)
      .then((r) => { if (!r.ok) throw new Error('Music file not found. Check the Music tab.'); return r.arrayBuffer(); }))
      .then((b) => this.ctx.decodeAudioData(b))
      .then((buf) => { e.bytes = buf.length * buf.numberOfChannels * 4; this.cacheBytes += e.bytes; this.evict(); return buf; })
      .catch((err) => { this.cache.delete(id); throw err; });
    this.cache.set(id, e);
    return e.p;
  },
  evict() {
    const keep = new Set([this.cur?.trackId, this.item(this.armedUid)?.trackId, Preview.trackId]);
    const list = [...this.cache.entries()].filter(([id, e]) => e.bytes && !keep.has(id)).sort((a, b) => a[1].used - b[1].used);
    while (this.cacheBytes > 700e6 && list.length) { const [id, e] = list.shift(); this.cache.delete(id); this.cacheBytes -= e.bytes; }
  },
  preload() {
    const items = this.items();
    const i = this.idx(this.armedUid);
    for (const it of [items[i], items[i + 1]]) if (it && App.track(it.trackId) && !App.track(it.trackId).missing) this.load(it.trackId).catch(() => {});
  },

  items() { return App.loaded?.items || []; },
  idx(u) { return this.items().findIndex((i) => i.uid === u); },
  item(u) { return this.items().find((i) => i.uid === u); },
  after(u) { const i = this.idx(u); return i >= 0 ? this.items()[i + 1]?.uid ?? null : null; },
  reset() {
    this.stopAll();
    this.played.clear(); this.interrupted = null;
    this.armedUid = this.items()[0]?.uid ?? null;
    this.changed();
  },
  changed() { this.onchange(); this.preload(); },

  pos(rec = this.cur) {
    if (!rec || !this.ctx) return 0;
    let p = this.ctx.currentTime - rec.startCtx + rec.offset;
    const st = rec.start || 0, L = rec.dur - st;
    if (rec.loop && L > 0 && p > rec.dur) p = st + ((p - st) % L);
    return clamp(p, 0, rec.dur);
  },
  points(trackId) {
    const t = App.track(trackId);
    const off = (App.settings.offsetMs || 0) / 1000;
    return (t?.points || []).map((p) => p + off);
  },
  nextPointDelta(rec = this.cur) {
    if (!rec) return null;
    const st = rec.start || 0;
    const pts = this.points(rec.trackId).filter((x) => x >= st && x <= rec.dur), pos = this.pos(rec);
    const p = pts.find((x) => x > pos + 0.06);
    if (p != null) return p - pos;
    if (rec.loop && pts.length) return rec.dur - pos + (pts[0] - st);
    return null;
  },

  async begin(spec) {
    const t = App.track(spec.trackId);
    if (!t || t.missing) throw new Error(`The music for “${spec.label}” is missing.`);
    const buf = await this.load(spec.trackId);
    const ctx = this.ctx;
    const when = spec.when ?? ctx.currentTime + 0.03;
    const d = buf.duration;
    let [ts, te] = trimOf(t, spec.raw);
    te = Math.min(te || d, d);
    if (te - ts < 0.2) { ts = 0; te = d; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = !!spec.loop;
    const tg = ctx.createGain(); tg.gain.value = t.gain ?? 1;
    const fg = ctx.createGain();
    const eg = ctx.createGain(); // short fade at a trimmed end so there's never a click
    const offset = clamp(spec.offset ?? 0, ts, te - 0.05);
    if (offset > ts + 0.01) { fg.gain.setValueAtTime(0, when); fg.gain.linearRampToValueAtTime(1, when + 0.04); }
    src.connect(tg).connect(fg).connect(eg).connect(this.master);
    if (src.loop) {
      src.loopStart = ts; src.loopEnd = te;
      src.start(when, offset);
    } else {
      const play = te - offset;
      if (te < d - 0.01) {
        const f = Math.min(0.12, play / 2);
        eg.gain.setValueAtTime(1, when + play - f); eg.gain.linearRampToValueAtTime(0, when + play);
      }
      src.start(when, offset, play);
    }
    const rec = { ...spec, src, fg, startCtx: when, offset, start: ts, dur: te };
    src.onended = () => this.ended(rec);
    return rec;
  },
  ended(rec) {
    if (this.cur !== rec || this.pending?.old === rec) return;
    const nx = rec.roll;
    if (nx) { // the next movement was scheduled to start at exactly this moment
      rec.roll = null;
      this.cur = nx;
      if (rec.uid) this.played.add(rec.uid);
      this.armedUid = this.after(nx.uid);
      this.changed();
      this.queueRoll();
      return;
    }
    this.cur = null;
    if (rec.uid) this.played.add(rec.uid);
    const it = rec.uid && !rec.loop && !rec.emergency ? this.item(rec.uid) : null;
    if (it?.auto && this.item(this.armedUid) && !this.other().cur) {
      setTimeout(() => { if (!this.cur && !this.pending && !this.interrupted) this.go(); }, 0); // could not schedule ahead: start it now
    }
    this.changed();
  },
  // ----- roll-over: start the next movement with no gap -----
  dropRoll(rec) {
    if (!rec) return;
    rec.rollTok = null;
    const r = rec.roll;
    if (r) { rec.roll = null; r.src.onended = null; try { r.src.stop(); } catch {} }
  },
  async queueRoll() {
    const rec = this.cur;
    if (!rec || rec.emergency || rec.loop || !rec.uid || this.pending) return;
    if (!this.item(rec.uid)?.auto) return;
    const nx = this.item(this.armedUid);
    if (!nx || nx.uid === rec.uid) return;
    const nt = App.track(nx.trackId);
    if (!nt || nt.missing) return;
    this.dropRoll(rec);
    const tok = (rec.rollTok = {});
    try {
      await this.load(nx.trackId);
      if (rec.rollTok !== tok || this.cur !== rec) return;
      const at = rec.startCtx + (rec.dur - rec.offset); // when this movement ends, on the audio clock
      if (at - this.now() < 0.08) return; // too late to schedule; ended() starts it straight away instead
      const nrec = await this.begin({ uid: nx.uid, trackId: nx.trackId, label: label(nx), loop: nx.loop, when: at });
      if (rec.rollTok !== tok || this.cur !== rec || this.pending) { nrec.src.onended = null; try { nrec.src.stop(); } catch {} return; }
      rec.roll = nrec;
    } catch { /* ended() falls back to starting the next movement */ }
  },
  requeue() { // call after anything that changes what comes next
    const rec = this.cur;
    if (!rec || this.pending) return;
    this.dropRoll(rec);
    this.queueRoll();
  },
  fadeAt(rec, at, secs) {
    const g = rec.fg.gain, now = this.now();
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setValueAtTime(g.value, Math.max(now, at));
    g.linearRampToValueAtTime(0, Math.max(now, at) + secs);
  },
  quickStop(rec, secs = 0.08) {
    if (!rec) return;
    this.dropRoll(rec);
    this.fadeAt(rec, this.now(), secs);
    try { rec.src.stop(this.now() + secs + 0.02); } catch {}
  },
  clearPending() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.rec) try { p.rec.src.stop(); } catch {}
    this.pending = null;
  },
  stopAll() { this.clearPending(); if (this.cur) { const r = this.cur; this.cur = null; this.quickStop(r); } },
  finishAt(at, fn) { return setTimeout(fn, Math.max(0, (at - this.now()) * 1000) + 30); },
  async keepAwake() { try { if (!this.wake && navigator.wakeLock) { this.wake = await navigator.wakeLock.request('screen'); this.wake.onrelease = () => (this.wake = null); } } catch {} },

  // ----- operator actions -----
  other() { return this === Engine ? Practice : Engine; },
  blocked() {
    if (!this.other().cur) return false;
    toast(this === Engine ? 'Music is playing on the Practice page. Stop it first.' : 'A parade is playing on the Run page. Stop it first.');
    return true;
  },
  async go() {
    if (this.busy || this.blocked()) return;
    await this.unlock();
    if (this.pending) { toast(this.pending.kind === 'change' ? 'Already changing on the next beat point.' : 'A stop is pending. Press As you were to cancel it.'); return; }
    this.busy = true;
    try {
      if (this.cur?.emergency) { toast('Emergency music is playing. GO will resume the parade after it.'); return; }
      if (this.cur) return await this.change();
      if (this.interrupted) return await this.resume();
      const it = this.item(this.armedUid);
      if (!it) { toast('End of the running order. Click a movement to play it again.'); return; }
      this.cur = await this.begin({ uid: it.uid, trackId: it.trackId, label: label(it), loop: it.loop });
      this.armedUid = this.after(it.uid);
      this.keepAwake();
      this.changed();
      this.queueRoll();
    } catch (e) { toast(e.message, true); } finally { this.busy = false; }
  },
  async change() {
    const next = this.item(this.armedUid);
    if (!next) { toast('That is the last movement. Press STOP to finish.'); return; }
    this.dropRoll(this.cur); // you are choosing the change yourself
    await this.load(next.trackId);
    const old = this.cur;
    const delta = next.transition === 'now' ? null : this.nextPointDelta(old);
    const at = this.now() + (delta ?? 0.04);
    const rec = await this.begin({ uid: next.uid, trackId: next.trackId, label: label(next), loop: next.loop, when: at });
    this.fadeAt(old, at, 0.04);
    this.pending = {
      kind: 'change', at, old, rec, to: label(next),
      timer: this.finishAt(at, () => {
        try { old.src.stop(); } catch {}
        this.pending = null; this.cur = rec;
        if (old.uid) this.played.add(old.uid);
        this.armedUid = this.after(next.uid);
        this.changed();
        this.queueRoll();
      }),
    };
    this.changed();
  },
  async resume() {
    const { uid: u, pos } = this.interrupted;
    const it = this.item(u);
    this.interrupted = null;
    if (!it) { this.changed(); return this.go(); }
    this.cur = await this.begin({ uid: u, trackId: it.trackId, label: label(it), loop: it.loop, offset: pos });
    this.armedUid = this.after(u);
    this.changed();
    this.queueRoll();
  },
  stop() {
    if (!this.cur) return;
    if (this.pending?.kind === 'stop' || this.pending?.kind === 'fade' || this.cur.emergency) return this.stopNow();
    if (this.pending?.kind === 'change' && !this.cancel(true)) return;
    const delta = this.nextPointDelta();
    if (delta == null || delta > 12) { toast('No beat point ahead, so fading out.'); return this.fade(); }
    const rec = this.cur, at = this.now() + delta;
    this.dropRoll(rec);
    this.fadeAt(rec, at, 0.04);
    this.pending = { kind: 'stop', at, old: rec, timer: this.finishAt(at + 0.05, () => this.finish(rec)) };
    this.changed();
  },
  finish(rec) {
    this.dropRoll(rec);
    try { rec.src.stop(); } catch {}
    this.pending = null;
    if (this.cur === rec) { this.cur = null; if (rec.uid) this.played.add(rec.uid); }
    this.changed();
  },
  stopNow() {
    if (!this.cur) return;
    this.clearPending();
    const rec = this.cur; this.cur = null;
    this.quickStop(rec);
    if (rec.uid) this.played.add(rec.uid);
    this.changed();
  },
  fade() {
    if (!this.cur) return;
    if (this.pending) this.cancel(true);
    const rec = this.cur, g = rec.fg.gain, now = this.now(), secs = App.settings.fadeSeconds || 5;
    this.dropRoll(rec);
    g.cancelScheduledValues(now); g.setValueAtTime(Math.max(g.value, 0.001), now);
    g.exponentialRampToValueAtTime(0.001, now + secs); g.setValueAtTime(0, now + secs);
    this.pending = { kind: 'fade', at: now + secs, old: rec, timer: this.finishAt(now + secs, () => this.finish(rec)) };
    this.changed();
  },
  cancel(quiet) {
    const p = this.pending;
    if (!p) return false;
    if (p.at - this.now() < 0.05 && p.kind !== 'fade') { if (!quiet) toast('Too late to cancel.'); return false; }
    clearTimeout(p.timer);
    const g = p.old.fg.gain, now = this.now();
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(1, now + (p.kind === 'fade' ? 0.4 : 0.02));
    if (p.rec) try { p.rec.src.stop(); } catch {}
    this.pending = null;
    if (!quiet) toast(p.kind === 'change' ? 'Change cancelled.' : p.kind === 'fade' ? 'Fade cancelled.' : 'Stop cancelled.');
    this.changed();
    this.queueRoll();
    return true;
  },
  asYouWere() {
    if (this.pending) return this.cancel();
    if (this.cur) {
      const rec = this.cur;
      this.cur = null; this.quickStop(rec, 0.12);
      if (rec.emergency) { this.changed(); return; }
      this.armedUid = rec.uid;
      toast(`As you were: ${rec.label} is ready again.`);
      return this.changed();
    }
    if (this.interrupted) { this.interrupted = null; toast('Resume cancelled. GO plays the next movement.'); return this.changed(); }
    const items = this.items();
    const i = this.armedUid == null ? items.length : this.idx(this.armedUid);
    if (i > 0) { this.armedUid = items[i - 1].uid; this.played.delete(this.armedUid); this.changed(); }
  },
  skip() {
    const it = this.item(this.armedUid);
    if (!it) return toast('Nothing left to skip.');
    this.armedUid = this.after(it.uid);
    toast(`Skipped ${label(it)}.`);
    this.changed();
    this.requeue();
  },
  arm(u) {
    this.armedUid = u; this.played.delete(u);
    this.changed();
    this.requeue();
  },
  async emergency(trackId) {
    if (this.blocked()) return;
    await this.unlock();
    const t = App.track(trackId);
    try {
      await this.load(trackId);
      if (this.cur && !this.cur.emergency) {
        this.clearPending();
        this.interrupted = { uid: this.cur.uid, pos: this.pos() };
      }
      const old = this.cur;
      this.cur = await this.begin({ uid: null, trackId, label: t.title, emergency: true });
      if (old) this.quickStop(old, 0.25);
      this.keepAwake();
      this.changed();
    } catch (e) { toast(e.message, true); }
  },
};

// preview player for the Parades and Music tabs (blocked while the parade is playing)
const Preview = {
  rec: null, trackId: null, raw: false, onchange: () => {},
  async play(trackId, from = 0, raw = false) {
    if (Engine.cur || Practice.cur) { toast('Stop the music before previewing.'); return false; }
    await Engine.unlock();
    this.stop();
    this.trackId = trackId;
    try {
      const t = App.track(trackId);
      this.raw = raw;
      const rec = await Engine.begin({ trackId, label: t.title, offset: from, raw });
      if (this.trackId !== trackId) { Engine.quickStop(rec); return false; }
      this.rec = rec;
      rec.src.onended = () => { if (this.rec === rec) { this.rec = null; this.trackId = null; this.onchange(); } };
    } catch (e) { toast(e.message, true); this.trackId = null; }
    this.onchange();
    return true;
  },
  stop() { if (this.rec) { const r = this.rec; this.rec = null; r.src.onended = null; Engine.quickStop(r); } this.trackId = null; this.onchange(); },
  pos() { return this.rec ? Engine.pos(this.rec) : 0; },
};

// ---------- PRACTICE page ----------
// A second player with the same parade behaviour, sharing the audio context and cache.
const Practice = Object.create(Engine, {
  ctx: { get: () => Engine.ctx, set: (v) => { Engine.ctx = v; } },
  master: { get: () => Engine.master, set: (v) => { Engine.master = v; } },
  cache: { get: () => Engine.cache },
  cacheBytes: { get: () => Engine.cacheBytes, set: (v) => { Engine.cacheBytes = v; } },
});
Object.assign(Practice, {
  cur: null, pending: null, armedUid: null, interrupted: null, played: new Set(), wake: null, busy: false,
  list: [], source: { kind: 'all' }, auto: true, repeat: 'off', onchange: () => {},
  items() { return this.list; },
  async go() {
    if (!this.cur && !this.interrupted && !this.item(this.armedUid)) this.armedUid = this.list[0]?.uid ?? null;
    return Engine.go.call(this);
  },
  ended(rec) {
    if (this.cur !== rec || this.pending?.old === rec) return;
    this.cur = null;
    if (rec.uid) this.played.add(rec.uid);
    if (!rec.emergency) {
      if (this.repeat === 'one' && rec.uid) this.armedUid = rec.uid;
      else if (this.armedUid == null && this.repeat === 'all') this.armedUid = this.list[0]?.uid ?? null;
      if ((this.auto || this.repeat === 'one') && this.item(this.armedUid)) setTimeout(() => { if (!this.cur && !Engine.cur) this.go(); }, 60);
    }
    this.changed();
  },
  async playNow(uid, offset = 0) {
    if (this.busy || this.blocked()) return;
    const it = this.item(uid);
    if (!it) return;
    await this.unlock();
    this.busy = true;
    try {
      const rec = await this.begin({ uid, trackId: it.trackId, label: label(it), offset });
      this.clearPending(); this.interrupted = null;
      const old = this.cur;
      this.cur = rec;
      if (old) this.quickStop(old, 0.06);
      this.armedUid = this.after(uid);
      this.keepAwake();
      this.changed();
    } catch (e) { toast(e.message, true); } finally { this.busy = false; }
  },
  seek(sec) {
    if (this.cur && !this.cur.emergency && this.cur.uid) return this.playNow(this.cur.uid, sec);
    const it = this.item(this.armedUid) || this.list[0];
    if (it) this.playNow(it.uid, sec);
  },
  next() {
    const from = this.cur?.uid ?? null;
    const n = from ? this.after(from) : this.armedUid;
    const uid = n ?? (this.repeat === 'all' ? this.list[0]?.uid : null);
    if (uid) this.playNow(uid); else toast('That was the last song.');
  },
  prev() {
    if (this.cur && this.pos() - (this.cur.start || 0) > 3) return this.seek(0);
    const i = this.idx(this.cur?.uid ?? this.armedUid);
    const uid = this.list[Math.max(0, (i < 0 ? this.list.length : i) - 1)]?.uid;
    if (uid) this.playNow(uid);
  },
});
const activeEngine = () => (App.view === 'practice' ? Practice : Engine);

// ---------- keeping audio alive through sleep and idle ----------
// When a laptop sleeps or sits idle, the browser can suspend the audio, or leave its clock frozen while it
// claims to be running. Either way the music goes silent and nothing responds. Watch the audio clock;
// if it stops, swap in a fresh audio context and leave the movement ready to carry on from where it stopped.
function recoverAudio(tell = true) {
  const old = Engine.ctx;
  if (!old) return;
  let what = null;
  for (const E of [Engine, Practice]) {
    const rec = E.cur;
    if (!rec) { E.clearPending(); continue; }
    if (!rec.emergency && rec.uid) { E.interrupted = { uid: rec.uid, pos: E.pos(rec) }; what = what || { E, rec }; }
    E.clearPending(); E.dropRoll(rec); rec.src.onended = null;
    try { rec.src.stop(); } catch {}
    E.cur = null;
  }
  if (Preview.rec) { Preview.rec.src.onended = null; Preview.rec = null; Preview.trackId = null; }
  Engine.ctx = null; Engine.master = null;
  try { old.close(); } catch {}
  Engine.ensure();
  Engine.ctx.resume().catch(() => {});
  AudioWatch.reset();
  Engine.changed(); Practice.changed(); Preview.onchange();
  if (tell && what) toast(`The computer paused the audio. Press GO to carry on ${what.rec.label} from ${fmt(what.E.interrupted.pos)}.`, true);
}
const AudioWatch = {
  wall: 0, clock: 0, stalls: 0, off: 0,
  reset() { this.wall = 0; this.stalls = 0; this.off = 0; },
  check() {
    const ctx = Engine.ctx;
    if (!ctx || ctx.state === 'closed') return;
    const busy = !!(Engine.cur || Practice.cur || Preview.rec);
    const wall = performance.now() / 1000, clock = ctx.currentTime;
    if (ctx.state === 'running') {
      this.off = 0;
      const dw = wall - this.wall, dc = clock - this.clock;
      // clock barely moved while real time passed (twice in a row, so waking from sleep alone doesn't count)
      this.stalls = this.wall && dw > 0.4 && dc < dw * 0.2 ? this.stalls + 1 : 0;
      if (this.stalls >= 2) { this.stalls = 0; recoverAudio(busy); }
    } else if (busy) {
      ctx.resume().catch(() => {});
      if (++this.off >= 3) recoverAudio(true); // still suspended after ~3 s with music meant to be playing
    }
    this.wall = wall; this.clock = Engine.ctx?.currentTime ?? 0;
  },
};
setInterval(() => AudioWatch.check(), 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !Engine.ctx) return;
  if (Engine.ctx.state !== 'running') Engine.ctx.resume().catch(() => {});
  AudioWatch.reset();
});

async function buildPracticeList() {
  const src = Practice.source, q = ($('#prSearch')?.value || '').trim().toLowerCase();
  let items = [];
  if (src.kind === 'parade') {
    try {
      const p = await getParade(src.id);
      items = p.items.filter((it) => App.track(it.trackId) && !App.track(it.trackId).missing).map((it) => ({ uid: it.uid, trackId: it.trackId, label: it.label || '', loop: false, transition: 'beat' }));
    } catch (e) { toast(e.message, true); Practice.source = { kind: 'all' }; return buildPracticeList(); }
  } else {
    for (const cat of App.categories()) {
      if (src.kind === 'cat' && cat !== src.cat) continue;
      for (const t of App.library) if (t.category === cat && !t.missing) items.push({ uid: t.id, trackId: t.id, label: '', loop: false, transition: 'beat' });
    }
  }
  if (q) items = items.filter((it) => label(it).toLowerCase().includes(q) || App.track(it.trackId).title.toLowerCase().includes(q));
  Practice.list = items;
  const curUid = Practice.cur?.uid;
  if (curUid && Practice.idx(curUid) >= 0) Practice.armedUid = Practice.after(curUid);
  else if (Practice.idx(Practice.armedUid) < 0) Practice.armedUid = items[0]?.uid ?? null;
}

function renderChips() {
  const src = Practice.source;
  const chip = (text, on, click, cls = '') => h('button', { class: 'chip ' + cls + (on ? ' on' : ''), onclick: click }, text);
  const pick = async (s) => { Practice.source = s; await buildPracticeList(); renderPractice(true); };
  $('#prChips').replaceChildren(
    chip('All music', src.kind === 'all', () => pick({ kind: 'all' })),
    ...App.categories().filter((c) => App.library.some((t) => t.category === c && !t.missing)).map((c) => chip(c, src.kind === 'cat' && src.cat === c, () => pick({ kind: 'cat', cat: c }))),
    ...(App.parades.length ? [h('span', { class: 'chip-sep' }, 'Parades')] : []),
    ...App.parades.map((p) => chip(p.name, src.kind === 'parade' && src.id === p.id, () => pick({ kind: 'parade', id: p.id }), 'parade')));
}

async function renderPractice(rebuild) {
  if (rebuild) { await buildPracticeList(); renderChips(); }
  const P = Practice, cur = P.cur, p = P.pending;
  $('#prCards').replaceChildren(...(P.list.length ? P.list.map((it, i) => {
    const t = App.track(it.trackId);
    const playing = cur?.uid === it.uid, next = cur && !cur.emergency && P.armedUid === it.uid;
    return h('button', { class: 'card' + (playing ? ' playing' : '') + (next ? ' next' : ''), onclick: () => P.playNow(it.uid), title: 'Play ' + label(it) },
      h('span', { class: 'card-top' }, P.source.kind === 'parade' ? h('span', { class: 'card-n' }, i + 1) : null,
        playing ? h('span', { class: 'eq' + (p ? ' paused' : '') }, h('i'), h('i'), h('i')) : null,
        h('span', { class: 'card-len' }, fmt(tlen(t)))),
      h('b', {}, label(it)),
      h('small', {}, it.label ? t.title + ' · ' + t.category : t.category),
      next ? h('span', { class: 'card-tag' }, 'Up next') : null);
  }) : [h('p', { class: 'hint' }, 'No songs match.')]));

  // dock
  const t = App.track(cur?.trackId) || App.track(P.item(P.armedUid)?.trackId);
  $('#dockTitle').textContent = cur ? cur.label : t ? label(P.item(P.armedUid)) : 'Pick a song';
  $('#dockSub').textContent = cur ? (cur.emergency ? 'Emergency play' : App.track(cur.trackId).category) : t ? 'Ready · press GO' : 'Click any song to play it';
  $('#dockBpm').textContent = t?.bpm ? bpmLabel(t) + ' BPM' : '';
  $('#dock').classList.toggle('live', !!cur);
  const banner = p ? (p.kind === 'stop' ? 'Stopping on the next beat point…' : p.kind === 'fade' ? 'Fading out…' : `Changing to ${p.to} on the next beat point…`) : '';
  $('#dockBanner').textContent = banner; $('#dockBanner').hidden = !banner;
  $('#pGo').disabled = !!p || !!cur?.emergency || (!!cur && !P.item(P.armedUid));
  $('#pStop').disabled = !cur;
  $('#pStop').classList.toggle('armed', !!p && p.kind !== 'change');
  $('#pFade').disabled = !cur;
  $('#pAuto').setAttribute('aria-pressed', String(P.auto));
  $('#pRepeat').textContent = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[P.repeat];
  $('#pRepeat').setAttribute('aria-pressed', String(P.repeat !== 'off'));
}

function tickPractice() {
  const P = Practice, cur = P.cur;
  const t = App.track(cur?.trackId);
  const ts = cur?.start || 0, te = cur?.dur || 0, pos = cur ? P.pos() : 0, dur = te - ts;
  $('#dockEl').textContent = fmt(pos - ts);
  $('#dockRem').textContent = cur ? '−' + fmt(te - pos) : '0:00';
  let on = false;
  if (cur && App.settings.beatFlash && t?.beats?.length) {
    const heard = pos - (P.ctx.outputLatency || P.ctx.baseLatency || 0);
    on = t.beats.some((b) => heard - b >= 0 && heard - b < 0.09);
  }
  $('#dockBeat').classList.toggle('on', on);
  const c = $('#dockBar'), dpr = devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), hh = Math.round(c.clientHeight * dpr);
  if (!w || !hh) return;
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  const g = c.getContext('2d'), mid = hh / 2;
  g.clearRect(0, 0, w, hh);
  const x = (s) => (dur > 0 ? clamp((s - ts) / dur, 0, 1) : 0) * (w - 12 * dpr) + 6 * dpr;
  g.fillStyle = colors.sunk; g.strokeStyle = colors.line; g.lineWidth = dpr;
  g.beginPath(); g.roundRect(6 * dpr, mid - 4 * dpr, w - 12 * dpr, 8 * dpr, 4 * dpr); g.fill(); g.stroke();
  if (!cur || dur <= 0) return;
  g.fillStyle = cur.emergency ? colors.stop : colors.accent;
  g.beginPath(); g.roundRect(6 * dpr, mid - 4 * dpr, Math.max(0, x(pos) - 6 * dpr), 8 * dpr, 4 * dpr); g.fill();
  g.fillStyle = colors.muted;
  for (const p of P.points(cur.trackId)) if (p >= ts && p <= te) g.fillRect(x(p) - dpr / 2, mid - 10 * dpr, dpr, 20 * dpr);
  if (P.pending && P.pending.kind !== 'fade') {
    g.fillStyle = P.pending.kind === 'stop' ? colors.stop : colors.go;
    g.fillRect(x(pos + (P.pending.at - P.now())) - 2 * dpr, mid - 14 * dpr, 4 * dpr, 28 * dpr);
  }
  g.fillStyle = colors.ink;
  g.beginPath(); g.arc(x(pos), mid, 7 * dpr, 0, Math.PI * 2); g.fill();
}

function wirePractice() {
  $('#prSearch').addEventListener('input', debounce(() => renderPractice(true), 150));
  $('#pGo').onclick = () => Practice.go();
  $('#pHold').onclick = () => Practice.asYouWere();
  $('#pStop').onclick = () => Practice.stop();
  $('#pFade').onclick = () => Practice.fade();
  $('#pPrev').onclick = () => Practice.prev();
  $('#pNext').onclick = () => Practice.next();
  $('#pAuto').onclick = () => { Practice.auto = !Practice.auto; renderPractice(); };
  $('#pRepeat').onclick = () => { Practice.repeat = { off: 'all', all: 'one', one: 'off' }[Practice.repeat]; renderPractice(); };
  $('#dockBar').addEventListener('click', (e) => {
    const cur = Practice.cur;
    if (!cur || cur.emergency) return;
    const r = e.currentTarget.getBoundingClientRect();
    Practice.seek(cur.start + clamp((e.clientX - r.left - 6) / (r.width - 12), 0, 1) * (cur.dur - cur.start));
  });
}

// ---------- RUN view ----------
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['bg', 'accent', 'line', 'muted', 'sunk', 'stop', 'hold', 'go', 'ink', 'panel']) colors[k] = cs.getPropertyValue('--' + k).trim();
}

function renderRun() {
  const has = !!App.loaded;
  $('#runEmpty').hidden = has; $('#runMain').hidden = !has;
  const E = Engine, cur = E.cur, p = E.pending;

  renderPill();
  if (!has) return;

  // running order
  const ol = $('#orderList');
  ol.replaceChildren(...E.items().map((it, i) => {
    const t = App.track(it.trackId);
    const isCur = cur && cur.uid === it.uid, isArmed = !cur?.emergency && E.armedUid === it.uid && !isCur;
    const li = h('li', {
      class: [isCur && 'current', isArmed && 'armed', E.played.has(it.uid) && !isCur && 'played', (!t || t.missing) && 'missing'].filter(Boolean).join(' '),
      draggable: true, title: 'Click to make this the next movement. Drag to reorder.',
      onclick: () => { if (!isCur) E.arm(it.uid); },
    },
      h('span', { class: 'n' }, i + 1),
      h('span', { class: 't' }, h('b', {}, label(it)), h('small', {}, !t || t.missing ? 'Music missing' : (it.label ? t.title + ' · ' : '') + fmt(tlen(t)) + (it.auto && !it.loop ? ' · ↪ rolls on' : ''))),
      h('span', { class: 'tag' }, isCur ? 'Now' : isArmed ? 'Next' : E.played.has(it.uid) ? '✓' : ''));
    dragRow(li, i, App.loaded, () => { renderRun(); Engine.requeue(); saveParade(App.loaded); if (App.editing === App.loaded) renderItems(); });
    return li;
  }));

  // now card
  const card = $('#nowCard');
  card.className = 'now panel ' + (cur?.emergency ? 'emergency' : p ? 'pending' : cur ? 'playing' : '');
  const armed = E.item(E.armedUid);
  let eyebrow, title, track = '', cue = '', banner = '', bclass = '';
  if (cur) {
    const t = App.track(cur.trackId);
    eyebrow = cur.emergency ? 'Emergency play' : 'Playing';
    title = cur.label; track = cur.emergency ? t.category : (cur.label !== t.title ? t.title + ' · ' : '') + t.category + (cur.loop ? ' · repeats until stopped' : '');
    if (p) {
      bclass = 'warn';
      banner = p.kind === 'stop' ? 'Stopping on the next beat point…' : p.kind === 'fade' ? 'Fading out…' : `Changing to ${p.to} on the next beat point…`;
      banner += ' Press As you were to cancel.';
    } else if (!cur.emergency && !cur.loop && E.item(cur.uid)?.auto && armed) {
      banner = `Rolls straight into ${label(armed)} when this finishes.`;
    } else if (cur.emergency && E.interrupted) {
      banner = `When this finishes, press GO to resume ${label(E.item(E.interrupted.uid) || {})}.`;
    }
  } else if (E.interrupted) {
    const it = E.item(E.interrupted.uid);
    eyebrow = 'Ready to resume';
    title = it ? label(it) : '—'; track = `Carries on from ${fmt(E.interrupted.pos)}`;
    banner = 'Press GO to resume, or As you were to move on instead.';
  } else if (armed) {
    const t = App.track(armed.trackId);
    eyebrow = 'Ready · press GO';
    title = label(armed); track = t ? (armed.label ? t.title + ' · ' : '') + t.category : '';
    cue = armed.cue;
    if (!t || t.missing) { banner = 'The music for this movement is missing. Fix it in the Music tab or skip it.'; bclass = 'bad'; }
  } else {
    eyebrow = 'Parade complete'; title = 'End of running order';
    track = E.items().length ? 'Click a movement on the left to play it again.' : 'This parade is empty. Add music in the Parades tab.';
  }
  $('#nowEyebrow').textContent = eyebrow;
  $('#nowLabel').textContent = title;
  $('#nowTrack').textContent = track;
  $('#nowCue').hidden = !cue; $('#nowCue').textContent = cue ? 'Cue: ' + cue : '';
  $('#banner').hidden = !banner; $('#banner').textContent = banner; $('#banner').className = 'banner ' + bclass;
  const bt = App.track(cur?.trackId || armed?.trackId);
  $('#bpmText').textContent = bt?.bpm ? bpmLabel(bt) + ' BPM' : '';

  // up next
  const items = E.items();
  const ai = E.idx(E.armedUid);
  const start = cur || E.interrupted ? ai : ai + 1;
  const ups = ai >= 0 ? items.slice(start, start + 2) : [];
  $('#nextList').replaceChildren(...(ups.length ? ups.map((it, k) => {
    const t = App.track(it.trackId);
    return h('li', {}, h('span', { class: 'when' }, k === 0 ? (cur || E.interrupted ? 'Next' : 'Then') : 'After'),
      h('div', {}, h('b', {}, label(it)), h('small', {}, t ? (it.label ? t.title + ' · ' : '') + fmt(tlen(t)) : 'Music missing'),
        it.cue ? h('span', { class: 'ncue' }, 'Cue: ' + it.cue) : null));
  }) : [h('li', {}, h('span', { class: 'when' }, '—'), h('small', {}, 'Nothing after this.'))]));

  // buttons
  const delta = cur ? E.nextPointDelta() : null;
  $('#goHint').textContent = p ? 'Waiting…' : cur?.emergency ? 'After emergency' : cur ? (armed ? `Change to ${label(armed)}` : 'Last movement') : E.interrupted ? 'Resume' : armed ? 'Play ' + label(armed) : 'End of parade';
  $('#btnGo').disabled = !!p || !!cur?.emergency || (!cur && !E.interrupted && !armed) || (cur && !armed);
  $('#holdHint').textContent = p ? 'Cancel the ' + p.kind : cur ? (cur.emergency ? 'Stop emergency' : 'Stop and re-arm') : E.interrupted ? 'Cancel resume' : 'Back one movement';
  $('#stopHint').textContent = !cur ? 'Nothing playing' : (p && p.kind !== 'change') || cur.emergency ? 'Stop now' : delta == null ? 'Fade out (no beat points)' : 'On next beat point';
  $('#btnStop').disabled = !cur;
  $('#btnStop').classList.toggle('armed', !!p && p.kind !== 'change');
  $('#btnFade').disabled = !cur;
}

function renderPill() {
  const E = !Engine.cur && (Practice.cur || Practice.pending) ? Practice : Engine, cur = E.cur, p = E.pending;
  const pill = $('#statusPill');
  const state = cur?.emergency ? ['Emergency', 'emergency'] : p ? [{ stop: 'Stopping', change: 'Changing', fade: 'Fading' }[p.kind], 'pending'] : cur ? [E === Practice ? 'Practice' : 'Playing', 'playing'] : ['Ready', ''];
  pill.textContent = state[0]; pill.className = 'pill ' + state[1];
}
function tick() {
  if (App.view === 'practice') tickPractice();
  requestAnimationFrame(tick);
  if (App.view === 'music') drawWave();
  if (App.view !== 'run' || !App.loaded) return;
  const E = Engine, cur = E.cur, armed = E.item(E.armedUid);
  const tid = cur?.trackId || (E.interrupted ? E.item(E.interrupted.uid)?.trackId : armed?.trackId);
  const t = App.track(tid);
  const [ts, te] = cur ? [cur.start || 0, cur.dur] : trimOf(t);
  const dur = te - ts;
  const pos = cur ? E.pos() : E.interrupted ? E.interrupted.pos : ts;
  $('#elapsed').textContent = fmt(pos - ts);
  $('#remaining').textContent = (cur?.loop ? '↻ ' : '−') + fmt(te - pos);

  // beat flash: a beat heard within the last 90 ms
  let on = false;
  if (cur && App.settings.beatFlash && t?.beats?.length) {
    const heard = pos - (E.ctx.outputLatency || E.ctx.baseLatency || 0);
    on = t.beats.some((b) => heard - b >= 0 && heard - b < 0.09);
  }
  $('#beatDot').classList.toggle('on', on);

  const c = $('#progress'), dpr = devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), hh = Math.round(56 * dpr);
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, hh);
  if (!(dur > 0)) return;
  const x = (s) => (clamp((s - ts) / dur, 0, 1) * (w - 12 * dpr)) + 6 * dpr;
  const mid = hh / 2;
  g.fillStyle = colors.sunk; g.strokeStyle = colors.line; g.lineWidth = dpr;
  g.beginPath(); g.roundRect(6 * dpr, mid - 6 * dpr, w - 12 * dpr, 12 * dpr, 6 * dpr); g.fill(); g.stroke();
  g.fillStyle = cur?.emergency ? colors.stop : colors.accent;
  g.beginPath(); g.roundRect(6 * dpr, mid - 6 * dpr, Math.max(0, x(pos) - 6 * dpr), 12 * dpr, 6 * dpr); g.fill();
  g.fillStyle = colors.muted;
  for (const p of E.points(tid)) if (p >= ts && p <= te) g.fillRect(x(p) - dpr / 2, mid - 14 * dpr, dpr, 28 * dpr);
  if (E.pending && E.pending.kind !== 'fade') {
    const pp = pos + (E.pending.at - E.now());
    g.fillStyle = E.pending.kind === 'stop' ? colors.stop : colors.go;
    g.fillRect(x(pp) - 2 * dpr, mid - 20 * dpr, 4 * dpr, 40 * dpr);
  }
  g.fillStyle = colors.ink;
  g.beginPath(); g.arc(x(pos), mid, 8 * dpr, 0, Math.PI * 2); g.fill();
}

// drag-to-reorder for running order and editor rows
let dragFrom = null;
function dragRow(li, i, parade, done) {
  li.addEventListener('dragstart', (e) => { dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
  li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragFrom = null; });
  li.addEventListener('dragover', (e) => { if (dragFrom == null) return; e.preventDefault(); li.classList.add('drop'); });
  li.addEventListener('dragleave', () => li.classList.remove('drop'));
  li.addEventListener('drop', (e) => {
    e.preventDefault(); li.classList.remove('drop');
    if (dragFrom == null || dragFrom === i) return;
    const [moved] = parade.items.splice(dragFrom, 1);
    parade.items.splice(i, 0, moved);
    dragFrom = null; done();
  });
}

// ---------- PARADES view ----------
const saveState = (txt, err) => { const s = $('#saveState'); s.textContent = txt; s.classList.toggle('err', !!err); };
const pendingSaves = new Map();
function saveParade(p) {
  if (!p) return;
  if (p === App.editing) saveState('Saving…');
  clearTimeout(pendingSaves.get(p.id));
  pendingSaves.set(p.id, setTimeout(async () => {
    pendingSaves.delete(p.id);
    try {
      const out = await api('PUT', '/api/parades/' + p.id, p);
      p.updated = out.updated;
      const s = App.parades.find((x) => x.id === p.id);
      if (s) { s.name = out.name; s.count = out.items.length; s.updated = out.updated; }
      if (p === App.editing) saveState('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      renderParadeList(); renderPicker();
    } catch (e) { if (p === App.editing) saveState('Not saved: ' + e.message, true); toast('Could not save: ' + e.message, true); }
  }, 500));
}

function renderPicker() {
  const sel = $('#paradePick');
  sel.replaceChildren(h('option', { value: '' }, App.parades.length ? 'Choose a parade…' : 'No parades yet'),
    ...App.parades.map((p) => h('option', { value: p.id }, `${p.name} (${p.count})`)));
  sel.value = App.loaded?.id || '';
}
function renderParadeList() {
  $('#paradeList').replaceChildren(...App.parades.map((p) => h('li', {},
    h('button', { class: App.editing?.id === p.id ? 'sel' : '', onclick: () => openEditor(p.id) },
      h('b', {}, p.name), h('small', {}, `${p.count} movement${p.count === 1 ? '' : 's'}${App.loaded?.id === p.id ? ' · loaded' : ''}`)))));
}
async function getParade(id) {
  if (App.loaded?.id === id) return App.loaded;
  if (App.editing?.id === id) return App.editing;
  return api('GET', '/api/parades/' + id);
}
async function openEditor(id) {
  try { App.editing = id ? await getParade(id) : null; } catch (e) { toast(e.message, true); App.editing = null; }
  renderEditor(); renderParadeList();
}
function renderEditor() {
  const p = App.editing;
  $('#editorEmpty').hidden = !!p; $('#editorBody').hidden = !p;
  if (!p) return;
  $('#pName').value = p.name; $('#pNotes').value = p.notes || '';
  saveState(p.updated ? 'Saved' : '');
  renderItems();
}
function renderItems() {
  const p = App.editing;
  if (!p) return;
  const rollable = p.items.slice(0, -1).filter((x) => !x.loop);
  $('#rollAll').textContent = rollable.length && rollable.every((x) => x.auto) ? 'Wait for GO on all' : 'Roll all into next';
  $('#itemsHint').textContent = p.items.length ? 'Drag the ⠿ handles to reorder. Changes save automatically, even while the parade is running.' : 'Add music from the library on the right.';
  $('#items').replaceChildren(...p.items.map((it, i) => {
    const t = App.track(it.trackId);
    const changed = () => { saveParade(p); if (p === App.loaded) renderRun(); };
    const structural = () => { renderItems(); changed(); if (p === App.loaded) Engine.requeue(); };
    const del = h('button', { class: 'icon', title: 'Remove', 'aria-label': 'Remove movement', onclick: (e) => confirmClick(e.currentTarget, '✓', () => { p.items.splice(i, 1); if (p === App.loaded && Engine.armedUid === it.uid) Engine.armedUid = p.items[i]?.uid ?? null; structural(); }) }, '✕');
    const li = h('li', { draggable: false },
      h('span', { class: 'handle', title: 'Drag to reorder', onmousedown: () => (li.draggable = true), onmouseup: () => (li.draggable = false) }, '⠿'),
      h('span', { class: 'n' }, i + 1),
      h('div', { class: 'body' },
        h('div', { class: 'meta' + (!t || t.missing ? ' bad' : '') }, t ? `${t.title} · ${t.category} · ${fmt(tlen(t))}${t.missing ? ' · file missing' : ''}` : 'Music missing'),
        h('div', { class: 'grid2' },
          h('input', { value: it.label || '', placeholder: t?.title || 'Movement name', maxLength: 120, 'aria-label': 'Movement name', oninput: (e) => { it.label = e.target.value; changed(); } }),
          h('input', { value: it.cue || '', placeholder: 'Cue for the operator, e.g. GO on “ARMS”', maxLength: 500, 'aria-label': 'Cue', oninput: (e) => { it.cue = e.target.value; changed(); } })),
        h('div', { class: 'opts' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!it.loop, onchange: (e) => { it.loop = e.target.checked; structural(); } }), 'Repeat until stopped'),
          h('label', { class: 'check', title: it.loop ? 'A movement that repeats until stopped never finishes by itself.' : i === p.items.length - 1 ? 'This is the last movement.' : 'When this finishes, the next movement starts by itself with no gap. Leave off to wait for GO.' },
            h('input', { type: 'checkbox', checked: !!it.auto && !it.loop, disabled: !!it.loop || i === p.items.length - 1, onchange: (e) => { it.auto = e.target.checked; structural(); } }), 'Roll into the next movement when finished'),
          h('label', {}, 'When GO is pressed during the previous piece: ',
            h('select', { onchange: (e) => { it.transition = e.target.value; changed(); } },
              h('option', { value: 'beat', selected: it.transition !== 'now' }, 'change on next beat point'),
              h('option', { value: 'now', selected: it.transition === 'now' }, 'change straight away'))))),
      h('div', { class: 'acts' },
        h('button', { class: 'icon', title: 'Preview', 'aria-label': 'Preview', onclick: () => togglePreview(it.trackId) }, Preview.trackId === it.trackId ? '■' : '▶'),
        del));
    dragRow(li, i, p, () => { li.draggable = false; structural(); });
    return li;
  }));
}
function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const out = [];
  for (const cat of App.categories()) {
    const rows = App.library.filter((t) => t.category === cat && !t.missing && (!q || t.title.toLowerCase().includes(q)));
    if (!rows.length) continue;
    out.push(h('div', { class: 'lib-cat' }, cat));
    for (const t of rows) out.push(h('div', { class: 'lib-row' },
      h('span', { title: t.title }, t.title), h('small', {}, fmt(tlen(t))),
      h('span', {},
        h('button', { class: 'icon', title: 'Preview', 'aria-label': 'Preview ' + t.title, onclick: () => togglePreview(t.id) }, Preview.trackId === t.id ? '■' : '▶'),
        h('button', { class: 'icon add', title: 'Add to parade', 'aria-label': 'Add ' + t.title, onclick: () => addToParade(t) }, '+'))));
  }
  $('#libList').replaceChildren(...(out.length ? out : [h('p', { class: 'hint' }, App.library.length ? 'No music matches.' : 'No music yet. Import it in the Music tab.')]));
}
function addToParade(t) {
  const p = App.editing;
  if (!p) return toast('Pick or create a parade first.');
  p.items.push({ uid: uid(), trackId: t.id, label: '', cue: '', loop: false, transition: 'beat' });
  if (p === App.loaded && Engine.armedUid == null) Engine.armedUid = p.items[p.items.length - 1].uid;
  renderItems(); saveParade(p); if (p === App.loaded) { renderRun(); Engine.requeue(); }
  $('#items').lastElementChild?.scrollIntoView({ block: 'nearest' });
}
async function togglePreview(id) {
  if (Preview.trackId === id) Preview.stop(); else await Preview.play(id);
}
async function newParade(name = 'New parade', items = []) {
  const p = await api('POST', '/api/parades', { name, items });
  App.parades.push({ id: p.id, name: p.name, count: p.items.length, updated: p.updated });
  App.parades.sort((a, b) => a.name.localeCompare(b.name));
  renderPicker();
  App.editing = p; renderEditor(); renderParadeList();
  setView('parades');
  $('#pName').focus(); $('#pName').select();
  return p;
}
function loadParade(p) {
  if (Engine.cur) { toast('Stop the music before changing parades.'); renderPicker(); return false; }
  App.loaded = p;
  Engine.reset();
  App.settings.lastParade = p?.id || '';
  saveSettings();
  renderPicker(); renderParadeList();
  return true;
}

// ---------- MUSIC view ----------
const Wave = { id: null, peaks: null, width: 0, pos: 0, buf: null };
function bpmLabel(t) { return !t.bpm ? '' : t.bpm2 ? `${Math.round(t.bpm)}→${Math.round(t.bpm2)}` : String(Math.round(t.bpm)); }
function status(t) {
  if (t.missing) return ['bad', 'File missing'];
  if (!t.analysed) return ['plain', 'Analysing…'];
  if (!t.points.length) return ['plain', 'Fade only'];
  if (t.checked) return ['ok', 'Checked'];
  if ((t.category === 'Slow to Quick Time' && !t.change) || t.confidence < 6.5) return ['warn', 'Check points'];
  return ['ok', 'Auto'];
}
function renderTracks() {
  const q = $('#musicSearch').value.trim().toLowerCase();
  const rows = [];
  for (const cat of App.categories()) {
    for (const t of App.library.filter((x) => x.category === cat && (!q || x.title.toLowerCase().includes(q) || cat.toLowerCase().includes(q)))) {
      const [cls, txt] = status(t);
      rows.push(h('tr', { class: Wave.id === t.id ? 'sel' : '', onclick: () => openWave(t.id) },
        h('td', {}, t.title), h('td', {}, t.category), h('td', { class: 'num' }, fmt(tlen(t))),
        h('td', { class: 'num' }, bpmLabel(t) || '–'), h('td', { class: 'num' }, t.points.length || '–'),
        h('td', {}, h('span', { class: 'badge ' + cls }, txt))));
    }
  }
  $('#trackRows').replaceChildren(...rows);
  const here = App.library.filter((t) => !t.missing).length;
  $('#musicFolder').textContent = WEB
    ? `${here} of ${App.library.length} tracks are ready on this laptop. Music from the repo's tracks folder loads by itself. Music you choose here stays in this browser and is never uploaded.`
    : `${here} tracks in ${App.musicDir}. You can also copy music files into that folder and press Rescan folder.`;
  $('#catList').replaceChildren(...App.categories().map((c) => h('option', { value: c })));
}
async function openWave(id) {
  const t = App.track(id);
  if (!t) return;
  if (Preview.trackId) Preview.stop();
  Wave.id = id; Wave.peaks = null; Wave.buf = null; Wave.pos = 0;
  $('#beatEdit').hidden = false;
  $('#wChange').hidden = t.category !== 'Slow to Quick Time';
  $('#tTitle').value = t.title; $('#tCat').value = t.category; $('#tGain').value = t.gain ?? 1; $('#tChecked').checked = !!t.checked;
  gainOut(); renderTrimInfo();
  renderTracks();
  if (t.missing) return toast('This file is missing from the music folder.', true);
  try { Wave.buf = await Engine.load(id); if (Wave.id === id) Wave.peaks = null; } catch (e) { toast(e.message, true); }
}
const patchTrack = debounce(async (id, patch) => {
  try { const t = await api('PATCH', '/api/tracks/' + id, patch); Object.assign(App.track(id), t); renderTracks(); }
  catch (e) { toast('Could not save: ' + e.message, true); }
}, 400);
function setPoints(pts) {
  const t = App.track(Wave.id);
  t.points = [...pts].sort((a, b) => a - b).map((x) => Math.round(x * 1000) / 1000);
  t.checked = false; $('#tChecked').checked = false;
  patchTrack(t.id, { points: t.points, checked: false });
  renderTracks();
}
function gainOut() { const g = +$('#tGain').value; $('#tGainOut').textContent = (g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB'; }
function wavePos() { return Preview.trackId === Wave.id && Preview.rec ? Preview.pos() : Wave.pos; }
function drawWave() {
  const c = $('#wave');
  if ($('#beatEdit').hidden || !Wave.buf) return;
  const dpr = devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), hh = Math.round(150 * dpr);
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; Wave.peaks = null; }
  const buf = Wave.buf, t = App.track(Wave.id);
  if (!Wave.peaks) {
    const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / w)), pk = new Float32Array(w);
    for (let i = 0; i < w; i++) { let m = 0; for (let k = i * step, e = Math.min(d.length, k + step); k < e; k += 4) m = Math.max(m, Math.abs(d[k])); pk[i] = m; }
    Wave.peaks = pk;
  }
  const g = c.getContext('2d'), mid = hh / 2, dur = buf.duration, x = (s) => (s / dur) * w;
  g.clearRect(0, 0, w, hh);
  g.fillStyle = colors.line;
  for (let i = 0; i < w; i++) { const a = Wave.peaks[i] * mid * 0.9; g.fillRect(i, mid - a, 1, a * 2 || 1); }
  g.fillStyle = colors.muted; g.globalAlpha = 0.45;
  for (const b of t.beats) g.fillRect(x(b), hh - 14 * dpr, dpr, 14 * dpr);
  g.globalAlpha = 1; g.fillStyle = colors.accent;
  for (const p of t.points) g.fillRect(x(p) - dpr, 0, 2.5 * dpr, hh);
  if (t.change > 0) { // where slow time turns into quick time
    g.fillStyle = colors.hold; g.fillRect(x(t.change) - 2 * dpr, 0, 4 * dpr, hh);
    g.font = `600 ${12 * dpr}px system-ui, sans-serif`; g.fillStyle = colors.ink;
    g.fillText('Quick time', x(t.change) + 6 * dpr, 16 * dpr);
  }
  // trimmed-off parts greyed out, with drag handles
  const [ts, te] = trimOf(t);
  g.fillStyle = colors.bg; g.globalAlpha = 0.72;
  g.fillRect(0, 0, x(ts), hh); g.fillRect(x(te), 0, w - x(te), hh);
  g.globalAlpha = 1;
  for (const [at, side] of [[ts, 1], [te, -1]]) {
    g.fillStyle = colors.go;
    g.fillRect(x(at) - 1.5 * dpr, 0, 3 * dpr, hh);
    g.beginPath(); g.roundRect(x(at) - (side > 0 ? 0 : 12 * dpr), hh / 2 - 16 * dpr, 12 * dpr, 32 * dpr, 3 * dpr); g.fill();
  }
  g.fillStyle = colors.stop;
  g.fillRect(x(wavePos()) - dpr, 0, 2 * dpr, hh);
}
function renderTrimInfo() {
  const t = App.track(Wave.id);
  if (!t) return;
  const [ts, te] = trimOf(t), d = t.duration || 0;
  const s1 = (v) => v.toFixed(2) + ' s';
  const f1 = (v) => `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`;
  $('#trimInfo').textContent = !t.trimEnd ? 'Working out where the music starts and ends…'
    : `Plays ${f1(ts)} to ${f1(te)} · cuts ${s1(ts)} from the start and ${s1(Math.max(0, d - te))} from the end${t.trimSet ? ' · set by hand' : ' · automatic'}`;
}
// Mono 22.05 kHz copy made with the browser's own high-quality resampler, so results
// match the analysis that prepared the bundled beat points.
async function analysisAudio(buf) {
  try {
    const rate = 22050;
    const off = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const out = await off.startRendering();
    return { chans: [out.getChannelData(0)], rate };
  } catch {
    return { chans: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), rate: buf.sampleRate };
  }
}
const chansOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
async function autoTrim(id) {
  const t = App.track(id), buf = await Engine.load(id);
  const tr = MusterBeat.findTrim(chansOf(buf), buf.sampleRate);
  Object.assign(t, await api('PATCH', '/api/tracks/' + id, { duration: Math.round(buf.duration * 1000) / 1000, trimStart: tr.start, trimEnd: tr.end, trimSet: false }));
}
async function analyseTrack(id, resetPoints, change) {
  const t = App.track(id);
  const buf = await Engine.load(id);
  const patch = { duration: Math.round(buf.duration * 1000) / 1000, analysed: true };
  if (!t.trimSet) { const tr = MusterBeat.findTrim(chansOf(buf), buf.sampleRate); patch.trimStart = tr.start; patch.trimEnd = tr.end; }
  if (PRIOR[t.category] || resetPoints) {
    const { chans, rate } = await analysisAudio(buf);
    const r = MusterBeat.analyse(chans, rate, { priorBpm: PRIOR[t.category] || 116, tempoChange: t.category === 'Slow to Quick Time', change });
    Object.assign(patch, { bpm: r.bpm, bpm2: r.bpm2, change: r.change, beats: r.beats, confidence: r.confidence, av: 2 });
    if (!t.points.length || resetPoints === 'all') patch.points = MusterBeat.pointsFrom(r.beats, 4, 0, r.change);
  }
  const out = await api('PATCH', '/api/tracks/' + id, patch);
  Object.assign(t, out);
}
let analysing = false;
async function analyseQueue() {
  if (analysing) return;
  analysing = true;
  try {
    // new tracks, plus Slow to Quick tracks analysed before tempo-change detection existed
    const upgrade = (x) => x.category === 'Slow to Quick Time' && (x.av || 0) < 2 && !x.checked;
    for (const t of App.library.filter((x) => !x.missing && (!x.analysed || upgrade(x)))) {
      try { await analyseTrack(t.id, upgrade(t) ? 'all' : undefined); } catch (e) { toast(`Could not read ${t.title}: ${e.message}`, true); }
      renderTracks(); renderLibrary();
    }
    for (const t of App.library.filter((x) => !x.missing && x.analysed && !x.trimEnd && !x.trimSet)) {
      try { await autoTrim(t.id); } catch (e) { toast(`Could not read ${t.title}: ${e.message}`, true); }
    }
    renderTracks(); renderLibrary();
  } finally { analysing = false; }
}
async function refreshLibrary(lib) { App.setLibrary(lib); renderTracks(); renderLibrary(); renderRun(); analyseQueue(); }

// ---------- SETTINGS ----------
const saveSettings = debounce(async () => { try { App.settings = await api('PUT', '/api/settings', App.settings); } catch (e) { toast('Settings not saved: ' + e.message, true); } }, 400);
const dark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const th = App.settings.theme === 'system' ? (dark.matches ? 'night' : 'day') : App.settings.theme;
  document.documentElement.dataset.theme = th;
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('sel', b.dataset.theme === App.settings.theme));
  readColors();
}
function renderSettings() {
  const s = App.settings;
  $('#sFade').value = s.fadeSeconds; $('#sFadeOut').textContent = s.fadeSeconds + ' s';
  $('#sOffset').value = s.offsetMs; $('#sOffsetOut').textContent = (s.offsetMs > 0 ? '+' : '') + s.offsetMs + ' ms';
  $('#sVol').value = s.volume; $('#sVolOut').textContent = Math.round(s.volume * 100) + '%';
  $('#sFlash').checked = !!s.beatFlash;
  const guest = WEB && Cloud.user()?.guest;
  if (WEB) $('#quitBtn').textContent = guest ? 'Sign in to an account' : 'Sign out';
  $('#aboutText').textContent = guest
    ? `Muster ${App.version} (web, guest). ${App.library.length} tracks, ${App.parades.length} saved parades. You're using Muster without an account: everything is saved in this browser only. Download a backup now and then so you don't lose it.`
    : WEB ? `Muster ${App.version} (web). Signed in as ${Cloud.user()?.email}. ${App.library.length} tracks, ${App.parades.length} saved parades. Parades, settings and beat points are saved to your account; music stays in this browser.`
    : `Muster ${App.version}. Music folder: ${App.musicDir}. ${App.library.length} tracks, ${App.parades.length} saved parades. Everything stays on this computer.`;
}

// ---------- views ----------
function setView(v) {
  App.view = v;
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== 'view-' + v;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  if (v !== 'parades' && v !== 'music' && Preview.trackId) Preview.stop();
  if (v === 'parades') { renderParadeList(); renderLibrary(); if (!App.editing && App.loaded) { App.editing = App.loaded; renderEditor(); } }
  if (v === 'music') renderTracks();
  if (v === 'settings') renderSettings();
  if (v === 'run') renderRun();
  if (v === 'practice') renderPractice(true);
}

// ---------- keys ----------
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key;
  if (k >= '1' && k <= '9' && (App.view === 'run' || App.view === 'practice' || !$('#emergency').hidden)) { e.preventDefault(); closeEmergency(); playFavourite(+k); return; }
  if (!$('#emergency').hidden) { if (k === 'Escape') { e.preventDefault(); closeEmergency(); } return; }
  if (App.view === 'music' && !$('#beatEdit').hidden && (k === 'm' || k === 'M')) { e.preventDefault(); markPoint(); return; }
  const E = App.view === 'practice' ? Practice : Engine;
  if (!App.loaded && E === Engine) return;
  const act = { ' ': 'go', Enter: 'go', ArrowRight: 'go', PageDown: 'go', ArrowLeft: 'hold', Backspace: 'hold', Escape: 'stop', ArrowDown: 'stop', PageUp: 'stop', f: 'fade', F: 'fade', s: 'skip', S: 'skip', e: 'emer', E: 'emer' }[k];
  if (!act) return;
  e.preventDefault();
  if (tag === 'BUTTON') e.target.blur();
  ({ go: () => E.go(), hold: () => E.asYouWere(), stop: () => E.stop(), fade: () => E.fade(), skip: () => (E === Practice ? Practice.next() : E.skip()), emer: openEmergency })[act]();
});

// ----- emergency play + favourites (keys 1-9) -----
let editingFavs = false;
const favs = () => (App.settings.favourites || []).filter((id) => App.track(id) && !App.track(id).missing);
function playFavourite(n) {
  const id = favs()[n - 1];
  if (!id) return toast(`No favourite on key ${n}. Pin one in Emergency play.`);
  activeEngine().emergency(id);
}
function toggleFavourite(id) {
  const list = [...(App.settings.favourites || [])];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else if (favs().length >= 9) return toast('You can pin up to 9 favourites. Unpin one first.');
  else list.push(id);
  App.settings.favourites = list.filter((x) => App.track(x));
  saveSettings(); renderEmergency(); renderFavs();
}
function emergencyTile(t, n) {
  const pinned = favs().includes(t.id);
  return h('button', {
    class: 'tile' + (pinned ? ' pinned' : ''),
    onclick: () => { if (editingFavs) return toggleFavourite(t.id); closeEmergency(); activeEngine().emergency(t.id); },
  }, n ? h('span', { class: 'fkey' }, n) : null, h('span', { class: 'tname' }, t.title), h('small', {}, fmt(tlen(t)) + (pinned && !n ? ' · ★ pinned' : '')));
}
function renderEmergency() {
  const f = favs();
  $('#editFavs').textContent = editingFavs ? 'Done' : 'Edit favourites';
  $('#editFavs').classList.toggle('primary', editingFavs);
  $('#emergencyGrid').classList.toggle('editing', editingFavs);
  $('#emergencyHint').textContent = editingFavs
    ? 'Click any piece to pin or unpin it. Pinned pieces play with keys 1 to 9, in the order you pin them.'
    : 'Plays straight away. When it finishes, press GO to carry on with the parade. Favourites also play with keys 1 to 9.';
  const sections = [h('div', { class: 'cat' }, h('h3', {}, 'Favourites · keys 1–9'),
    f.length ? h('div', { class: 'tiles' }, f.map((id, i) => emergencyTile(App.track(id), i + 1)))
      : h('p', { class: 'hint' }, 'None yet. Press Edit favourites, then click the pieces you use most, like Royal Salute.'))];
  for (const cat of App.categories()) {
    const ts = App.library.filter((t) => t.category === cat && !t.missing);
    if (ts.length) sections.push(h('div', { class: 'cat' }, h('h3', {}, cat), h('div', { class: 'tiles' }, ts.map((t) => emergencyTile(t)))));
  }
  $('#emergencyGrid').replaceChildren(...sections);
}
function renderFavs() {
  const f = favs();
  $('#favList').replaceChildren(h('h3', {}, 'Favourites'), ...(f.length
    ? f.map((id, i) => h('button', { class: 'btn fav', onclick: () => activeEngine().emergency(id) }, h('kbd', {}, i + 1), App.track(id).title))
    : [h('p', { class: 'hint' }, 'Pin pieces in Emergency play to play them here or with keys 1 to 9.')]));
}
function openEmergency() {
  editingFavs = false;
  renderEmergency();
  $('#emergency').hidden = false;
  $('#emergencyGrid .tile')?.focus();
}
function closeEmergency() { if (editingFavs) { editingFavs = false; } $('#emergency').hidden = true; }
function markPoint() {
  const t = App.track(Wave.id);
  if (!t || !Wave.buf) return;
  setPoints([...t.points, wavePos()]);
}

// ---------- wiring ----------
function wire() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail) b.blur(); });

  $('#paradePick').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return;
    try { const p = await getParade(id); if (loadParade(p)) setView('run'); } catch (err) { toast(err.message, true); renderPicker(); }
  });
  $('#btnGo').onclick = () => Engine.go();
  $('#btnHold').onclick = () => Engine.asYouWere();
  $('#btnStop').onclick = () => Engine.stop();
  $('#btnFade').onclick = () => Engine.fade();
  $('#btnSkip').onclick = () => Engine.skip();
  $('#btnEmergency').onclick = openEmergency;
  $('#closeEmergency').onclick = closeEmergency;
  $('#editFavs').onclick = () => { editingFavs = !editingFavs; renderEmergency(); };
  $('#emergency').addEventListener('click', (e) => { if (e.target.id === 'emergency') closeEmergency(); });
  $('#runNew').onclick = () => newParade().catch((e) => toast(e.message, true));
  $('#editLoaded').onclick = () => { App.editing = App.loaded; renderEditor(); setView('parades'); };

  // parades
  $('#newParade').onclick = () => newParade().catch((e) => toast(e.message, true));
  $('#pName').oninput = (e) => { App.editing.name = e.target.value; saveParade(App.editing); };
  $('#pNotes').oninput = (e) => { App.editing.notes = e.target.value; saveParade(App.editing); };
  $('#runThis').onclick = () => { if (App.loaded === App.editing || loadParade(App.editing)) setView('run'); };
  $('#rollAll').onclick = () => {
    const p = App.editing, cand = p.items.slice(0, -1).filter((x) => !x.loop);
    if (!cand.length) return toast('Add at least two movements first.');
    const on = !cand.every((x) => x.auto);
    cand.forEach((x) => (x.auto = on));
    renderItems(); saveParade(p);
    if (p === App.loaded) { renderRun(); Engine.requeue(); }
    toast(on ? 'Every movement now rolls into the next.' : 'Every movement now waits for GO.');
  };
  $('#dupParade').onclick = () => newParade(App.editing.name + ' (copy)', App.editing.items.map((it) => ({ ...it, uid: '' }))).catch((e) => toast(e.message, true));
  $('#exportParade').onclick = () => { const p = App.editing; download(p.name.replace(/[^\w\- ]+/g, '').trim() + '.muster.json', { app: 'muster', version: App.version, exported: new Date(), parades: [{ ...p, id: '' }] }); };
  $('#delParade').onclick = (e) => {
    const p = App.editing;
    if (App.loaded === p && Engine.cur) return toast('Stop the music before deleting the loaded parade.');
    confirmClick(e.currentTarget, 'Click again to delete', async () => {
      try {
        await api('DELETE', '/api/parades/' + p.id);
        App.parades = App.parades.filter((x) => x.id !== p.id);
        if (App.loaded === p) loadParade(null);
        App.editing = null; renderEditor(); renderParadeList(); renderPicker(); renderRun();
        toast(`Deleted ${p.name}. A copy is kept in the data/backups folder.`);
      } catch (err) { toast(err.message, true); }
    });
  };
  $('#importParade').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreFrom(f); };
  $('#libSearch').oninput = renderLibrary;
  Preview.onchange = () => { if (App.view === 'parades') { renderItems(); renderLibrary(); } $('#wPlay').textContent = Preview.trackId === Wave.id && Preview.rec ? 'Pause' : 'Play'; };

  // music
  $('#musicSearch').oninput = renderTracks;
  $('#importMusic').onchange = $('#importFolder').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    toast(`Importing ${files.length} file(s)…`);
    try {
      const r = await api('POST', '/api/music', fd);
      r.problems.forEach((p) => toast(p, true));
      if (r.saved.length) toast(`Imported ${r.saved.length} file(s). Detecting beats now.`);
      refreshLibrary(r.library);
    } catch (err) { toast(err.message, true); }
  };
  if (WEB) $('#rescan').textContent = 'Choose music folder';
  $('#rescan').onclick = async () => {
    if (WEB) return $('#importFolder').click();
    try { const r = await api('POST', '/api/rescan'); toast(r.added ? `Found ${r.added} new track(s).` : 'No new music found.'); refreshLibrary(r.library); } catch (err) { toast(err.message, true); } };
  $('#closeEdit').onclick = () => { Preview.stop(); Wave.id = null; Wave.buf = null; $('#beatEdit').hidden = true; renderTracks(); };
  $('#tTitle').oninput = (e) => { const t = App.track(Wave.id); if (e.target.value.trim()) { t.title = e.target.value; patchTrack(t.id, { title: t.title }); } };
  $('#tCat').onchange = (e) => { const t = App.track(Wave.id); if (e.target.value.trim()) { t.category = e.target.value.trim(); patchTrack(t.id, { category: t.category }); } };
  $('#tGain').oninput = (e) => { gainOut(); const t = App.track(Wave.id); t.gain = +e.target.value; patchTrack(t.id, { gain: t.gain }); if (Preview.rec) Preview.play(t.id, Preview.pos(), Preview.raw); };
  $('#tChecked').onchange = (e) => { const t = App.track(Wave.id); t.checked = e.target.checked; patchTrack(t.id, { checked: t.checked }); };
  let trimDrag = null;
  const waveTime = (e) => { const r = $('#wave').getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * Wave.buf.duration; };
  $('#wave').addEventListener('pointerdown', (e) => {
    if (!Wave.buf) return;
    const t = App.track(Wave.id), r = e.currentTarget.getBoundingClientRect();
    const [ts, te] = trimOf(t), px = (s) => r.left + (s / Wave.buf.duration) * r.width;
    const near = [['start', Math.abs(e.clientX - px(ts))], ['end', Math.abs(e.clientX - px(te))]].filter(([, dd]) => dd < 12).sort((a, b) => a[1] - b[1])[0];
    if (near) { trimDrag = near[0]; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    Wave.pos = waveTime(e);
    if (Preview.trackId === Wave.id && Preview.rec) Preview.play(Wave.id, Wave.pos, true);
  });
  $('#wave').addEventListener('pointermove', (e) => {
    const t = App.track(Wave.id);
    if (!Wave.buf || !t) return;
    if (!trimDrag) {
      const r = e.currentTarget.getBoundingClientRect(), [ts, te] = trimOf(t);
      const px = (s) => r.left + (s / Wave.buf.duration) * r.width;
      e.currentTarget.style.cursor = Math.min(Math.abs(e.clientX - px(ts)), Math.abs(e.clientX - px(te))) < 12 ? 'ew-resize' : 'crosshair';
      return;
    }
    const at = waveTime(e), [ts, te] = trimOf(t);
    if (trimDrag === 'start') t.trimStart = Math.round(clamp(at, 0, te - 0.5) * 1000) / 1000;
    else t.trimEnd = Math.round(clamp(at, ts + 0.5, Wave.buf.duration) * 1000) / 1000;
    if (!t.trimEnd) t.trimEnd = Wave.buf.duration;
    t.trimSet = true;
    renderTrimInfo();
  });
  const endDrag = () => {
    if (!trimDrag) return;
    trimDrag = null;
    const t = App.track(Wave.id);
    patchTrack(t.id, { trimStart: t.trimStart || 0, trimEnd: t.trimEnd, trimSet: true });
  };
  $('#wave').addEventListener('pointerup', endDrag);
  $('#wave').addEventListener('pointercancel', endDrag);
  $('#trimReset').onclick = async () => {
    if (!Wave.id) return;
    try { await autoTrim(Wave.id); renderTrimInfo(); renderTracks(); toast('Start and end reset to automatic.'); } catch (err) { toast(err.message, true); }
  };
  $('#wave').addEventListener('dblclick', markPoint);
  $('#wPlay').onclick = () => {
    if (Preview.trackId === Wave.id && Preview.rec) { Wave.pos = Preview.pos(); Preview.stop(); }
    else if (Wave.id) Preview.play(Wave.id, Wave.pos, true);
  };
  $('#wMark').onclick = markPoint;
  $('#wChange').onclick = async () => {
    const at = wavePos();
    if (!Wave.id || at < 4) return toast('Move the playhead to where quick time begins first.');
    toast('Rebuilding beats around ' + fmt(at) + '…');
    try { await analyseTrack(Wave.id, 'all', at); renderTracks(); toast('Done. Slow time before ' + fmt(at) + ', quick time after.'); }
    catch (err) { toast(err.message, true); }
  };
  $('#wDelete').onclick = () => {
    const t = App.track(Wave.id), at = wavePos();
    if (!t?.points.length) return;
    let best = 0;
    t.points.forEach((p, i) => { if (Math.abs(p - at) < Math.abs(t.points[best] - at)) best = i; });
    setPoints(t.points.filter((_, i) => i !== best));
  };
  $('#wApply').onclick = () => {
    const t = App.track(Wave.id);
    if (!t?.beats.length) return toast('No beats detected yet. Press Re-detect beats first.');
    setPoints(MusterBeat.pointsFrom(t.beats, clamp(+$('#wEvery').value || 4, 1, 64), Math.max(0, (+$('#wFrom').value || 1) - 1), t.change));
  };
  $('#wClear').onclick = (e) => confirmClick(e.currentTarget, 'Click again to clear', () => setPoints([]));
  $('#wAnalyse').onclick = async () => {
    if (!Wave.id) return;
    toast('Detecting beats…');
    try { await analyseTrack(Wave.id, App.track(Wave.id).points.length ? true : 'all'); renderTracks(); toast('Beats updated. Your beat points were kept; use Set points to rebuild them.'); }
    catch (err) { toast(err.message, true); }
  };

  // settings
  document.querySelectorAll('#themeSeg button').forEach((b) => (b.onclick = () => { App.settings.theme = b.dataset.theme; applyTheme(); saveSettings(); }));
  dark.addEventListener('change', applyTheme);
  $('#sFade').oninput = (e) => { App.settings.fadeSeconds = +e.target.value; renderSettings(); saveSettings(); };
  $('#sOffset').oninput = (e) => { App.settings.offsetMs = +e.target.value; renderSettings(); saveSettings(); };
  $('#sVol').oninput = (e) => { App.settings.volume = +e.target.value; if (Engine.master) Engine.master.gain.setTargetAtTime(App.settings.volume, Engine.now(), 0.03); renderSettings(); saveSettings(); };
  $('#sFlash').onchange = (e) => { App.settings.beatFlash = e.target.checked; saveSettings(); };
  $('#backupBtn').onclick = () => { if (WEB) download(`muster-backup-${new Date().toISOString().slice(0, 10)}.json`, Cloud.exportAll()); else location.href = '/api/backup'; };
  $('#restoreFile').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await restoreFrom(f); };
  $('#quitBtn').onclick = (e) => {
    if (Engine.cur || Practice.cur) return toast('Stop the music first.');
    if (WEB) return Cloud.user()?.guest ? Cloud.signOut() : confirmClick(e.currentTarget, 'Click again to sign out', () => Cloud.signOut());
    confirmClick(e.currentTarget, 'Click again to quit', async () => {
      await api('POST', '/api/quit').catch(() => {});
      document.body.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Muster has closed'), h('p', {}, 'You can close this tab. To start again, open Muster from its folder.')));
    });
  };
  window.addEventListener('beforeunload', (e) => { if (Engine.cur || Practice.cur) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Engine.cur) Engine.keepAwake(); });
}

async function restoreFrom(file) {
  if (Engine.cur) return toast('Stop the music before importing.');
  try {
    const data = JSON.parse(await file.text());
    const r = await api('POST', '/api/restore', data);
    toast(r.message);
    await loadState();
  } catch (e) { toast(e instanceof SyntaxError ? 'That file is not a Muster backup or parade file.' : e.message, true); }
}

async function loadState() {
  const s = await api('GET', '/api/state');
  App.settings = s.settings; App.version = s.version; App.musicDir = s.musicDir; App.parades = s.parades;
  App.setLibrary(s.library);
  applyTheme();
  if (!App.loaded && s.settings.lastParade && s.parades.some((p) => p.id === s.settings.lastParade)) {
    try { App.loaded = await api('GET', '/api/parades/' + s.settings.lastParade); Engine.reset(); } catch {}
  } else if (App.loaded) {
    try { App.loaded = await api('GET', '/api/parades/' + App.loaded.id); Engine.reset(); } catch { App.loaded = null; }
  }
  renderPicker(); renderParadeList(); renderLibrary(); renderTracks(); renderSettings(); renderRun(); renderFavs();
  analyseQueue();
}

(async function boot() {
  Engine.onchange = renderRun;
  Practice.onchange = () => { renderPractice(); renderPill(); };
  wirePractice();
  wire();
  readColors();
  try {
    if (WEB) await Cloud.start();
    await loadState();
    setView(App.parades.length ? 'run' : 'parades');
    if (!App.parades.length) toast('Welcome. Create your first parade to get started.');
  } catch (e) { toast(e.message, true); }
  requestAnimationFrame(tick);
})();
