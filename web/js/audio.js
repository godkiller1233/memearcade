/**
 * Music + sound effects.
 *
 * The background music is generated live with the Web Audio API - real
 * chiptune patterns, zero licensing, zero downloads, works offline.  Drop
 * your own .mp3/.ogg files into web/assets/music and they appear in the
 * settings list as an alternative (see docs/MUSIC-CREDITS.md for free sources
 * and how to credit them).
 */
import { state, notify, saveLocal, mirrorSettings } from './store.js';

const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const freq = (name) => {
  const m = /^([A-G]#?)(\d)$/.exec(name);
  if (!m) return 440;
  const midi = (Number(m[2]) + 1) * 12 + NOTE[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
};

/** Pattern mini-language: bars of 8th notes, "-" = rest, "." = hold. */
export const TRACKS = [
  {
    id: 'neon-runner', name: 'Neon Runner', mood: 'arcade', bpm: 128,
    lead: 'E5 - G5 - A5 - G5 - E5 - D5 - E5 - - - B4 - D5 - E5 - - D5 - B4 - A4 - - '.split(' '),
    bass: 'E2 . . . E2 . . . A1 . . . A1 . . . C2 . . . C2 . . . D2 . . . D2 . . .'.split(' '),
    pad: 'E4 - B4 - A3 - E4 - C4 - G4 - D4 - A4 - '.split(' '),
    drums: 'K - S - K - S - K - S - K K S -',
  },
  {
    id: 'lofi-pixel', name: 'Lofi Pixel', mood: 'chill', bpm: 84,
    lead: 'C5 - E5 - G5 - . - A4 - C5 - E5 - . - F4 - A4 - C5 - . - G4 - B4 - D5 - . - '.split(' '),
    bass: 'C2 . . . . . . . A1 . . . . . . . F1 . . . . . . . G1 . . . . . . .'.split(' '),
    pad: 'C4 - G4 - A3 - E4 - F3 - C4 - G3 - D4 - '.split(' '),
    drums: 'K - - S - - K - K - - S - - K -',
  },
  {
    id: 'hype-train', name: 'Hype Train', mood: 'hype', bpm: 150,
    lead: 'A5 A5 - E5 - A5 - C6 - B5 - A5 - G5 - E5 - '.split(' '),
    bass: 'A1 . A1 . A1 . A1 . F1 . F1 . G1 . G1 . '.split(' '),
    pad: 'A4 - E5 - F4 - C5 - G4 - D5 - A4 - E5 - '.split(' '),
    drums: 'K S K S K S K K S K S K S S K K',
  },
  {
    id: 'chip-suite', name: 'Chip Suite', mood: 'retro', bpm: 110,
    lead: 'D5 - F5 - A5 - F5 - G5 - E5 - C5 - - - D5 - F5 - A5 - C6 - A5 - - - '.split(' '),
    bass: 'D2 . . . D2 . . . G1 . . . G1 . . . C2 . . . C2 . . . A1 . . . A1 . . .'.split(' '),
    pad: 'D4 - A4 - G3 - D4 - C4 - G4 - A3 - E4 - '.split(' '),
    drums: 'K - S - K S - S',
  },
  {
    id: 'zen-garden', name: 'Zen Garden', mood: 'ambient', bpm: 72,
    lead: 'G4 - . - B4 - . - D5 - . - . - B4 - . - A4 - . - C5 - . - E5 - . - . - C5 - . - '.split(' '),
    bass: 'G1 . . . . . . . E1 . . . . . . . C2 . . . . . . . D2 . . . . . . .'.split(' '),
    pad: 'G3 - D4 - E3 - B3 - C4 - G4 - D4 - A4 - '.split(' '),
    drums: 'K - - - - - - -',
  },
  {
    id: 'boss-rush', name: 'Boss Rush', mood: 'intense', bpm: 160,
    lead: 'E5 - E5 - G5 - B5 - A5 - G5 - E5 - D5 - E5 - G5 - A5 - B5 - . - '.split(' '),
    bass: 'E1 . E1 . E1 . E1 . E1 . E1 . E1 . E1 . E1 . E1 . E1 . D1 . D1 . D1 .'.split(' '),
    pad: 'E4 - B4 - G4 - D5 - A3 - E4 - B3 - F#4 - '.split(' '),
    drums: 'K S K S K S K K S K S K S K S S',
  },
];

let ctx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let playing = null;
let scheduler = null;
let step = 0;
let nextTime = 0;
let unlocked = false;

function ensureContext() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  masterGain = ctx.createGain();
  musicGain = ctx.createGain();
  sfxGain = ctx.createGain();
  musicGain.connect(masterGain);
  sfxGain.connect(masterGain);
  masterGain.connect(ctx.destination);
  applyVolumes();
  return ctx;
}

function applyVolumes() {
  if (!ctx) return;
  const a = state.settings.audio || {};
  masterGain.gain.value = a.master ?? 0.8;
  musicGain.gain.value = a.music ? (a.musicVolume ?? 0.32) : 0;
  sfxGain.gain.value = a.sfx ? (a.sfxVolume ?? 0.7) : 0;
}

export function unlockAudio() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  unlocked = true;
  if (state.settings.audio?.music) startMusic();
}

export function isUnlocked() {
  return unlocked;
}

/* ------------------------------------------------------------------ *
 * music
 * ------------------------------------------------------------------ */

export function currentTrack() {
  return TRACKS.find((t) => t.id === state.settings.audio?.track) || TRACKS[0];
}

export function startMusic() {
  const c = ensureContext();
  if (!c) return;
  if (playing) stopMusic();
  const track = currentTrack();
  playing = track;
  step = 0;
  nextTime = c.currentTime + 0.1;
  applyVolumes();
  scheduler = setInterval(() => schedule(track), 60);
  notify();
}

export function stopMusic() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  playing = null;
  notify();
}

export function toggleMusic(force) {
  const on = force === undefined ? !state.settings.audio.music : !!force;
  state.settings.audio.music = on;
  applyVolumes();
  if (on) {
    unlockAudio();
    startMusic();
  } else {
    stopMusic();
  }
  notify();
  return on;
}

export function setTrack(id) {
  state.settings.audio.track = id;
  if (state.settings.audio.music) startMusic();
  notify();
}

export function setMusicVolume(v) {
  state.settings.audio.musicVolume = Math.max(0, Math.min(1, v));
  applyVolumes();
  // Sliders fire on every input: both writers are debounced, so this is cheap.
  saveLocal();
  mirrorSettings();
}

export function setSfxVolume(v) {
  state.settings.audio.sfxVolume = Math.max(0, Math.min(1, v));
  applyVolumes();
  saveLocal();
  mirrorSettings();
}

function stepDuration(track) {
  return 30 / track.bpm; // 8th notes
}

function schedule(track) {
  if (!ctx || !playing) return;
  const dur = stepDuration(track);
  while (nextTime < ctx.currentTime + 0.35) {
    const lead = pick(track.lead, step);
    const bass = pick(track.bass, step);
    const pad = track.pad ? pick(track.pad, step) : null;
    const drumChar = track.drums ? track.drums[step % track.drums.length] : '-';
    if (lead && lead !== '-' && lead !== '.') tone(freq(lead), nextTime, dur * 1.7, 'square', 0.16, musicGain);
    if (bass && bass !== '-' && bass !== '.') tone(freq(bass), nextTime, dur * 1.9, 'triangle', 0.24, musicGain);
    if (pad && pad !== '-' && pad !== '.') {
      const f = freq(pad);
      tone(f, nextTime, dur * 2.6, 'sawtooth', 0.05, musicGain);
      tone(f * 1.005, nextTime, dur * 2.6, 'sawtooth', 0.045, musicGain);
    }
    if (drumChar === 'K') kick(nextTime);
    if (drumChar === 'S') snare(nextTime);
    if (drumChar === 'H') hat(nextTime);
    nextTime += dur;
    step++;
    if (step > 4096) step = 0;
  }
}

function pick(arr, i) {
  if (!arr?.length) return null;
  return arr[i % arr.length];
}

function tone(frequency, at, duration, type = 'square', gainAmount = 0.2, dest = null) {
  if (!ctx || !Number.isFinite(frequency)) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainAmount, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(dest || musicGain);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function kick(at) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(48, at + 0.12);
  gain.gain.setValueAtTime(0.5, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
  osc.connect(gain);
  gain.connect(musicGain);
  osc.start(at);
  osc.stop(at + 0.2);
}

function noise(at, duration, gainAmount, filterFreq) {
  if (!ctx) return;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = filterFreq;
  const gain = ctx.createGain();
  gain.gain.value = gainAmount;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(musicGain);
  src.start(at);
}

function snare(at) {
  noise(at, 0.14, 0.16, 1200);
}

function hat(at) {
  noise(at, 0.05, 0.07, 6000);
}

/* ------------------------------------------------------------------ *
 * sound effects
 * ------------------------------------------------------------------ */

const SFX = {
  click: () => blip(660, 0.06, 'square', 0.12),
  hover: () => blip(880, 0.03, 'sine', 0.06),
  join: () => arp([523, 659, 784], 0.07),
  leave: () => arp([392, 330, 262], 0.07),
  message: () => blip(988, 0.05, 'triangle', 0.12),
  notify: () => arp([659, 880], 0.08),
  win: () => arp([523, 659, 784, 1046], 0.11),
  lose: () => arp([440, 349, 262], 0.13),
  error: () => arp([220, 180], 0.12),
  turn: () => blip(740, 0.07, 'triangle', 0.14),
  correct: () => arp([784, 1046], 0.08),
  wrong: () => arp([300, 240], 0.09),
};

export function sfx(name) {
  if (!state.settings.audio?.sfx) return;
  const c = ensureContext();
  if (!c || c.state !== 'running') return;
  const fn = SFX[name] || SFX.click;
  try {
    fn();
  } catch {}
}

function blip(frequency, duration, type, gainAmount) {
  if (!ctx) return;
  const at = ctx.currentTime + 0.001;
  tone(frequency, at, duration, type, gainAmount, sfxGain);
}

function arp(notes, spacing) {
  if (!ctx) return;
  let at = ctx.currentTime + 0.001;
  for (const n of notes) {
    tone(n, at, spacing * 2.4, 'square', 0.16, sfxGain);
    at += spacing;
  }
}

/* ------------------------------------------------------------------ *
 * user-supplied tracks (web/assets/music)
 * ------------------------------------------------------------------ */

export async function listMusicFiles() {
  try {
    const res = await fetch('/api/music');
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}

let audioElement = null;
export function playFile(url, volume = 0.4) {
  stopFile();
  if (!url) return;
  audioElement = new Audio(url);
  audioElement.loop = true;
  audioElement.volume = volume;
  audioElement.play().catch(() => {});
}

export function stopFile() {
  if (audioElement) {
    audioElement.pause();
    audioElement = null;
  }
}
