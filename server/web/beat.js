/* Muster beat detector.
   Onset envelope (spectral flux) -> tempo estimate (autocorrelation with a tempo prior)
   -> beat positions (dynamic-programming tracker, after Ellis 2007).
   Works in the browser (window.MusterBeat) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MusterBeat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET_SR = 11025;
  const N = 1024;
  const H = 128;

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  /** Downmix + decimate channels (array of Float32Array) to ~TARGET_SR mono. */
  function toMono(channels, sr) {
    const factor = Math.max(1, Math.round(sr / TARGET_SR));
    const len = Math.floor(channels[0].length / factor);
    const out = new Float32Array(len);
    const nc = channels.length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      const base = i * factor;
      for (let c = 0; c < nc; c++) {
        const ch = channels[c];
        for (let k = 0; k < factor; k++) s += ch[base + k];
      }
      out[i] = s / (factor * nc);
    }
    return { x: out, sr: sr / factor };
  }

  function onsetEnvelope(x, sr) {
    const frames = Math.max(0, Math.floor((x.length - N) / H) + 1);
    const env = new Float32Array(frames);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const bins = Math.floor(N / 2);
    let prev = new Float32Array(bins), cur = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
      const off = f * H;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let flux = 0;
      for (let b = 1; b < bins; b++) {
        const m = Math.log1p(100 * Math.hypot(re[b], im[b]));
        cur[b] = m;
        const d = m - prev[b];
        if (d > 0 && f > 0) flux += d;
      }
      env[f] = flux;
      const t = prev; prev = cur; cur = t;
    }
    // remove slow trend (1 s moving average), rectify, normalise
    const fps = sr / H;
    const w = Math.max(1, Math.round(fps));
    const out = new Float32Array(frames);
    let acc = 0;
    for (let i = 0; i < frames; i++) {
      acc += env[i];
      if (i >= w) acc -= env[i - w];
      const mean = acc / Math.min(i + 1, w);
      out[i] = Math.max(0, env[i] - mean);
    }
    let sq = 0;
    for (let i = 0; i < frames; i++) sq += out[i] * out[i];
    const sd = Math.sqrt(sq / Math.max(1, frames)) || 1;
    for (let i = 0; i < frames; i++) out[i] /= sd;
    return { env: out, fps, offset: N / 2 / sr };
  }

  function estimateTempo(env, fps, priorBpm) {
    const minLag = Math.floor((60 * fps) / 200);
    const maxLag = Math.ceil((60 * fps) / 45);
    let best = -Infinity, bestLag = Math.round((60 * fps) / priorBpm);
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (env.length - lag);
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (60 * fps) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / 0.5, 2));
      const v = ac[lag] * w;
      if (v > best) { best = v; bestLag = lag; }
    }
    // parabolic refinement
    const a = ac[bestLag - 1] || 0, b = ac[bestLag], c = ac[bestLag + 1] || 0;
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const lag = bestLag + Math.max(-0.5, Math.min(0.5, shift));
    return (60 * fps) / lag;
  }

  function trackBeats(env, fps, bpm, tightness) {
    const n = env.length;
    const p = (60 * fps) / bpm;
    const score = new Float64Array(n);
    const back = new Int32Array(n).fill(-1);
    const lo = Math.round(p / 2), hi = Math.round(2 * p);
    for (let i = 0; i < n; i++) {
      let bestV = -Infinity, bestJ = -1;
      for (let j = i - hi; j <= i - lo; j++) {
        if (j < 0) continue;
        const r = Math.log((i - j) / p);
        const v = score[j] - tightness * r * r;
        if (v > bestV) { bestV = v; bestJ = j; }
      }
      score[i] = env[i] + (bestJ >= 0 ? Math.max(0, bestV) : 0);
      back[i] = bestV > 0 ? bestJ : -1;
    }
    // end: best score within the final period
    let end = n - 1, endV = -Infinity;
    for (let i = Math.max(0, n - Math.round(p)); i < n; i++) if (score[i] > endV) { endV = score[i]; end = i; }
    const beats = [];
    for (let i = end; i >= 0; i = back[i]) beats.push(i);
    beats.reverse();
    return beats;
  }

  // strongest autocorrelation tempo within [lo, hi] BPM for a stretch of the envelope
  function bandPeak(seg, fps, lo, hi) {
    let best = 0, bpmBest = lo;
    for (let bpm = lo; bpm <= hi; bpm += 0.5) {
      const lag = Math.round((60 * fps) / bpm);
      let s = 0;
      for (let i = lag; i < seg.length; i++) s += seg[i] * seg[i - lag];
      s /= seg.length - lag;
      if (s > best) { best = s; bpmBest = bpm; }
    }
    return bpmBest;
  }

  /* Find where a slow march (~55-82 BPM) turns into quick time (~105-128 BPM).
     In quick time the slow band locks onto half the quick tempo, which is the tell.
     Returns the change time in seconds, or 0 if there is no clear single slow→quick change. */
  function findTempoChange(env, fps) {
    const win = Math.round(6 * fps), hop = Math.round(2 * fps);
    const q = [];
    for (let s = 0; s + win <= env.length; s += hop) {
      const seg = env.subarray(s, s + win);
      const slow = bandPeak(seg, fps, 55, 82), quick = bandPeak(seg, fps, 100, 130);
      q.push(quick >= 106 && quick <= 126 && Math.abs(slow * 2 - quick) < 4 ? 1 : 0);
    }
    const n = q.length;
    if (n < 8) return 0;
    let bestC = 0, bestScore = -1;
    for (let c = 4; c <= n - 5; c++) { // at least ~8 s of slow and ~10 s of quick
      let score = 0;
      for (let i = 0; i < n; i++) score += i < c ? 1 - q[i] : q[i];
      if (score > bestScore) { bestScore = score; bestC = c; }
    }
    if (bestScore / n < 0.8) return 0;
    return (bestC * hop + win / 2) / fps - 1; // midway between the last slow and first quick window centres
  }

  function measure(env, frames) {
    let energy = 0;
    for (let i = 0; i < env.length; i++) energy += env[i];
    const mean = energy / env.length;
    let hit = 0;
    for (const f of frames) {
      let m = 0;
      for (let k = Math.max(0, f - 2); k <= Math.min(env.length - 1, f + 2); k++) m = Math.max(m, env[k]);
      hit += m;
    }
    return frames.length ? hit / frames.length / (mean || 1) : 0;
  }

  /** channels: Float32Array[]; sr: sample rate
      opts.priorBpm (default 112); opts.tempoChange: look for a slow→quick change.
      Returns { bpm, bpm2, change, beats, confidence }. bpm2/change are 0 without a tempo change. */
  function analyse(channels, sr, opts) {
    opts = opts || {};
    const prior = opts.priorBpm || 112;
    const tight = opts.tightness || 120;
    const mono = toMono(channels, sr);
    const { env, fps, offset } = onsetEnvelope(mono.x, mono.sr);
    if (env.length < fps * 4) return { bpm: 0, bpm2: 0, change: 0, beats: [], confidence: 0 };
    const toSec = (f) => Math.round((f / fps + offset) * 1000) / 1000;
    const r3 = (v) => Math.round(v * 10) / 10;

    const change = opts.change > 0 ? opts.change : opts.tempoChange ? findTempoChange(env, fps) : 0;
    if (change > 0) {
      const cf = Math.round((change - offset) * fps);
      const A = env.subarray(0, cf), B = env.subarray(cf);
      const bpm = estimateTempo(A, fps, 66), bpm2 = estimateTempo(B, fps, 116);
      const fa = trackBeats(A, fps, bpm, tight);
      const fb = trackBeats(B, fps, bpm2, tight).map((f) => f + cf);
      const minGap = (0.5 * 60 * fps) / bpm2;
      const frames = fa.filter((f) => f < cf - minGap).concat(fb);
      return { bpm: r3(bpm), bpm2: r3(bpm2), change: Math.round(change * 1000) / 1000, beats: frames.map(toSec), confidence: Math.round(measure(env, frames) * 100) / 100 };
    }
    const bpm = estimateTempo(env, fps, prior);
    const frames = trackBeats(env, fps, bpm, tight);
    return { bpm: r3(bpm), bpm2: 0, change: 0, beats: frames.map(toSec), confidence: Math.round(measure(env, frames) * 100) / 100 };
  }

  /** Beat points: every `every` beats starting at beat index `from`.
      With a tempo change (seconds), the count restarts at the first beat of the new tempo. */
  function pointsFrom(beats, every, from, change) {
    every = Math.max(1, every);
    const split = change > 0 ? beats.findIndex((b) => b >= change) : -1;
    const out = [];
    const end = split > 0 ? split : beats.length;
    for (let i = from || 0; i < end; i += every) out.push(beats[i]);
    if (split > 0) for (let i = split + (from || 0); i < beats.length; i += every) out.push(beats[i]);
    return out;
  }

  /** Where the sound really starts and ends. channels: Float32Array[].
      Threshold -45 dBFS in 10 ms windows; keeps 20 ms before the first sound
      and 250 ms after the last so the final note's ring isn't chopped. */
  function findTrim(channels, sr, opts) {
    const thr = Math.pow(10, ((opts && opts.db) || -45) / 20);
    const n = channels[0].length, win = Math.max(1, Math.round(sr * 0.01)), dur = n / sr;
    const loud = (i) => {
      for (const ch of channels) for (let k = i, e = Math.min(n, i + win); k < e; k++) if (ch[k] > thr || ch[k] < -thr) return true;
      return false;
    };
    let a = 0;
    while (a < n && !loud(a)) a += win;
    if (a >= n) return { start: 0, end: Math.round(dur * 1000) / 1000 };
    let b = Math.floor((n - 1) / win) * win;
    while (b > a && !loud(b)) b -= win;
    const start = Math.max(0, a / sr - 0.02), end = Math.min(dur, (b + win) / sr + 0.25);
    if (end - start < 0.5) return { start: 0, end: Math.round(dur * 1000) / 1000 };
    return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  }

  return { analyse, pointsFrom, estimateTempo, findTrim };
});
