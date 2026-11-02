// Precompute track metadata + beat points for a music folder.
// usage: node analyze.js <musicDir> <out.json>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Beat = require('../server/web/beat.js');

const [dir, outFile] = process.argv.slice(2);
const AUDIO = /\.(m4a|mp3|wav|aac|flac|ogg)$/i;

const TITLE_FIX = {
  'Advance Australia Fair (Instrumen': 'Advance Australia Fair (Instrumental)',
  'Advance In Revew Order - Navy': 'Advance in Review Order - Navy',
  'Advance In Review Order - Army': 'Advance in Review Order - Army',
  'Advance In Review Order - RAAF': 'Advance in Review Order - RAAF',
  'The Moray Fifth': 'The Moray Firth',
  'Reveille_Rouse': 'Reveille & Rouse',
  'Slow To Quick - RAAF': 'Slow to Quick - RAAF',
  'March past': 'March Past',
};

const RULES = [
  [/salute|point of war|schedule/i, 'Salutes'],
  [/advance australia fair|god save/i, 'National Anthems'],
  [/drum/i, 'Drums'],
  [/slow to quick|dignified occasion/i, 'Slow to Quick Time'],
  [/scipio|duke of york|golden spurs|preobrajensky/i, 'Slow March'],
  [/advance in rev/i, 'Advance in Review Order'],
  [/moray|great little army|invercargill|officer of the day|holyrood/i, 'Step Off'],
  [/infantry song|greensleeves/i, 'Inspection'],
  [/march past|jollies|glorious victory|air force march|waltzing matilda|national emblem|army of the nile/i, 'Quick March'],
  [/reveille|alert|carry on|long g|last post|lights out|rouse|retreat/i, 'Bugle Calls'],
  [/abide with me|sunset|eternal father/i, 'Hymns & Sunset'],
  [/dress/i, 'Drill Commands'],
];
// categories that get beat points by default, with their tempo prior
const PRIOR = {
  'Quick March': 116, 'Step Off': 116, 'Advance in Review Order': 112, 'Inspection': 100,
  'Slow March': 66, 'Slow to Quick Time': 70,
};

const files = fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort();
const out = {};
for (const file of files) {
  const base = file.replace(/\.[^.]+$/, '');
  const m = base.match(/^(\d+)\s+(.*)$/);
  const raw = m ? m[2] : base;
  const title = TITLE_FIX[raw] || raw;
  const category = (RULES.find(([re]) => re.test(title)) || [null, 'Other'])[1];
  const full = path.join(dir, file);
  const duration = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', full]).toString());
  const entry = { title, category, order: m ? parseInt(m[1], 10) : 100, duration: Math.round(duration * 1000) / 1000, bpm: 0, beats: [], points: [], confidence: 0, analysed: true };
  {
    const pcm2 = execFileSync('ffmpeg', ['-v', 'error', '-i', full, '-ac', '2', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const st = new Float32Array(pcm2.buffer, pcm2.byteOffset, pcm2.length / 4);
    const L = new Float32Array(st.length / 2), R = new Float32Array(st.length / 2);
    for (let i = 0; i < L.length; i++) { L[i] = st[2 * i]; R[i] = st[2 * i + 1]; }
    const tr = Beat.findTrim([L, R], 44100);
    entry.trimStart = tr.start; entry.trimEnd = tr.end;
  }
  if (PRIOR[category]) {
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', full, '-ac', '1', '-ar', '11025', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const r = Beat.analyse([x], 11025, { priorBpm: PRIOR[category], tempoChange: category === 'Slow to Quick Time' });
    entry.bpm = r.bpm; entry.bpm2 = r.bpm2; entry.change = r.change; entry.av = 2;
    entry.beats = r.beats;
    entry.confidence = r.confidence;
    entry.points = Beat.pointsFrom(r.beats, 4, 0, r.change);
  }
  out[file] = entry;
  console.log(`trim ${String(entry.trimStart).padStart(5)}-${String(entry.trimEnd).padStart(7)}/${entry.duration}  ${category.padEnd(24)} ${String(entry.bpm).padStart(6)} bpm  conf ${String(entry.confidence).padStart(5)}  ${entry.beats.length} beats  ${title}`);
}
fs.writeFileSync(outFile, JSON.stringify(out));
