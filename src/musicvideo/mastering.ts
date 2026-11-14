/**
 * VeloBot AI mastering (Master page): measures the song, sets the mastering
 * desk to taste for the genre, renders the result through exactly the chain
 * the film export uses (desk → loudness target, true peak −1 dB), measures
 * that too, and scores both out of 100. Every move comes with what it did and
 * why. Local ffmpeg only: no film-engine or token cost.
 *
 * Measured: integrated loudness (LUFS), true peak, loudness range (LRA),
 * crest factor (peak − RMS: how much punch / dynamics), tonal balance (low
 * < 150 Hz, mid ~1 kHz, high > 6 kHz, each relative to the whole), stereo
 * width (side vs mid level).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegLog } from '../media/ffmpeg.js';
import { downloadToFile } from '../services/storage.service.js';
import { DEFAULT_MASTER_AUDIO, masterAudioFilters, type MasterAudio } from '../studio/types.js';

export interface MasterMeasure {
  lufs: number | null;
  truePeak: number | null;
  lra: number | null;
  crest: number | null;
  /** Band level minus the whole signal's RMS, dB. */
  low: number | null;
  mid: number | null;
  high: number | null;
  /** Side minus mid level, dB (−∞ mono; ~ −8 typical; > −3 very wide / phasey). */
  width: number | null;
  score: number;
  notes: string[];
}

export interface AiMasterReport {
  at: string;
  genre: string;
  targetLufs: number;
  original: MasterMeasure;
  mastered: MasterMeasure;
  settings: MasterAudio;
  steps: { control: keyof MasterAudio | 'loudness'; label: string; value: string; why: string }[];
  summary: string;
}

/** Analysed length: enough for intro, verse and chorus; keeps the button under ~30 s. */
const LIMIT_SECONDS = 150;

function num(log: string, pattern: RegExp): number | null {
  const match = pattern.exec(log);
  if (!match) return null;
  const value = match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** RMS level (dB) of the file through a filter. */
async function rms(file: string, filter: string): Promise<number | null> {
  const log = await ffmpegLog(['-hide_banner', '-nostats', '-t', String(LIMIT_SECONDS), '-i', file, '-vn', '-af', `${filter}${filter ? ',' : ''}astats=measure_perchannel=none`, '-f', 'null', '-']).catch(() => '');
  return num(log.slice(log.lastIndexOf('Overall')), /RMS level dB:\s+(-?[\d.]+|-inf)/);
}

interface Targets {
  low: number;
  mid: number;
  high: number;
  crest: [number, number];
  label: string;
}

/** Tonal and dynamic targets by genre (relative band levels, crest window). */
function targetsFor(genre: string): Targets {
  const g = genre.toLowerCase();
  if (/afro|amapiano|hip|trap|rap|drill|dancehall|reggae|r&b|rnb|street/.test(g)) return { low: -3.5, mid: -5, high: -15, crest: [8, 12], label: 'warm, bass-forward and punchy (afro / hip-hop / dancehall)' };
  if (/edm|house|techno|dance|pop|electro/.test(g)) return { low: -4.5, mid: -5, high: -13, crest: [7.5, 11], label: 'bright, tight and loud (pop / dance)' };
  if (/acoustic|folk|jazz|classical|soul|ballad|gospel|highlife|blues/.test(g)) return { low: -5.5, mid: -4.5, high: -14.5, crest: [10, 15], label: 'natural and open, dynamics kept (acoustic / soul / gospel)' };
  if (/rock|metal|punk|alt/.test(g)) return { low: -4.5, mid: -4, high: -13.5, crest: [8, 12], label: 'forward mids, solid low end (rock)' };
  return { low: -4.5, mid: -5, high: -14, crest: [8.5, 13], label: 'balanced, radio-ready' };
}

async function measure(file: string, targetLufs: number, targets: Targets): Promise<MasterMeasure> {
  // All passes at once (each is one ffmpeg read of the file).
  const [loud, stats, lowRms, midRms, highRms, midSig, sideSig] = await Promise.all([
    ffmpegLog(['-hide_banner', '-nostats', '-t', String(LIMIT_SECONDS), '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']).catch(() => ''),
    ffmpegLog(['-hide_banner', '-nostats', '-t', String(LIMIT_SECONDS), '-i', file, '-vn', '-af', 'astats=measure_perchannel=none', '-f', 'null', '-']).catch(() => ''),
    rms(file, 'lowpass=f=150'),
    rms(file, 'bandpass=f=1000:width_type=o:w=2'),
    rms(file, 'highpass=f=6000'),
    rms(file, 'pan=mono|c0=0.5*c0+0.5*c1'),
    rms(file, 'pan=mono|c0=0.5*c0-0.5*c1'),
  ]);
  const summary = loud.slice(loud.lastIndexOf('Summary'));
  const lufs = num(summary, /I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const lra = num(summary, /LRA:\s+(-?[\d.]+)\s+LU/);
  const truePeak = num(summary, /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  const overall = stats.slice(stats.lastIndexOf('Overall'));
  const whole = num(overall, /RMS level dB:\s+(-?[\d.]+|-inf)/);
  const peak = num(overall, /Peak level dB:\s+(-?[\d.]+|-inf)/);
  const crest = whole !== null && peak !== null ? +(peak - whole).toFixed(1) : null;
  const rel = (value: number | null): number | null => (value !== null && whole !== null ? +(value - whole).toFixed(1) : null);
  const width = midSig !== null && sideSig !== null ? +(sideSig - midSig).toFixed(1) : null;
  const m = { lufs, truePeak, lra, crest, low: rel(lowRms), mid: rel(midRms), high: rel(highRms), width };
  return { ...m, ...score(m, targetLufs, targets) };
}

/** 0-100: how close to a professional master for this genre (loudness, peaks, tone, dynamics, width). */
function score(m: Omit<MasterMeasure, 'score' | 'notes'>, targetLufs: number, t: Targets): { score: number; notes: string[] } {
  let total = 100;
  const notes: string[] = [];
  const take = (points: number, note: string): void => {
    const lost = Math.round(Math.min(points, 30));
    if (lost >= 2) {
      total -= lost;
      notes.push(`${note} (−${lost})`);
    }
  };
  if (m.lufs !== null) take(Math.abs(m.lufs - targetLufs) * 2.5, `loudness ${m.lufs.toFixed(1)} LUFS vs ${targetLufs} target`);
  if (m.truePeak !== null && m.truePeak > -1) take(6 + (m.truePeak + 1) * 6, `true peak ${m.truePeak.toFixed(1)} dB (clips on streaming; −1 dB is the limit)`);
  if (m.low !== null) take(Math.max(0, Math.abs(m.low - t.low) - 1) * 3, `low end ${m.low > t.low ? 'heavy' : 'thin'} (${m.low.toFixed(1)} vs ${t.low} dB)`);
  if (m.mid !== null) take(Math.max(0, Math.abs(m.mid - t.mid) - 1.5) * 2, `mids ${m.mid > t.mid ? 'boxy / forward' : 'scooped'} (${m.mid.toFixed(1)} vs ${t.mid} dB)`);
  if (m.high !== null) take(Math.max(0, Math.abs(m.high - t.high) - 1.5) * 2, `top end ${m.high > t.high ? 'harsh' : 'dull'} (${m.high.toFixed(1)} vs ${t.high} dB)`);
  if (m.crest !== null) {
    if (m.crest > t.crest[1]) take((m.crest - t.crest[1]) * 2.5, `dynamics loose: ${m.crest.toFixed(1)} dB crest, the mix lacks glue`);
    if (m.crest < t.crest[0]) take((t.crest[0] - m.crest) * 4, `over-compressed: ${m.crest.toFixed(1)} dB crest, little punch left`);
  }
  if (m.width !== null) {
    if (m.width < -16) take((-16 - m.width) * 1.2, `narrow stereo image (${m.width.toFixed(1)} dB side)`);
    if (m.width > -4) take((m.width + 4) * 3, `very wide / phasey stereo (${m.width.toFixed(1)} dB side), weak on phones and mono`);
  }
  if (m.lra !== null && m.lra > 14) take((m.lra - 14) * 1.5, `loudness swings a lot (LRA ${m.lra.toFixed(1)} LU)`);
  return { score: Math.max(0, Math.min(100, total)), notes };
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
const half = (value: number): number => Math.round(value * 2) / 2;

/** Analyses the song and returns VeloBot's master with both scores. */
export async function aiMaster(songKey: string, input: { genre: string; targetLufs: number }): Promise<AiMasterReport> {
  const dir = await mkdtemp(join(tmpdir(), 'mv-aimaster-'));
  try {
    const song = join(dir, 'song');
    await downloadToFile(songKey, song);
    const targets = targetsFor(input.genre);
    const original = await measure(song, input.targetLufs, targets);

    const settings: MasterAudio = { ...DEFAULT_MASTER_AUDIO };
    const steps: AiMasterReport['steps'] = [];
    const eq = (field: 'lowDb' | 'midDb' | 'highDb', measured: number | null, target: number, name: string, dead: number): void => {
      if (measured === null) return;
      const diff = target - measured;
      if (Math.abs(diff) <= dead) return;
      // Correct about 70 % of the gap: a master nudges the mix, it doesn't remix it.
      const value = half(clamp(diff * 0.7, 6));
      if (!value) return;
      settings[field] = value;
      steps.push({
        control: field,
        label: name,
        value: `${value > 0 ? '+' : ''}${value} dB`,
        why: `${name} sits at ${measured.toFixed(1)} dB against ${target} dB for a ${targets.label} sound: ${value > 0 ? 'lifted' : 'pulled back'} so the song ${field === 'lowDb' ? (value > 0 ? 'has weight on speakers and earbuds' : 'stops sounding muddy and boomy') : field === 'midDb' ? (value > 0 ? 'brings the vocal and instruments forward' : 'loses the boxy, honky sound') : value > 0 ? 'gets air and clarity' : 'stops sounding harsh and tiring'}.`,
      });
    };
    eq('lowDb', original.low, targets.low, 'Low end (100 Hz)', 1);
    eq('midDb', original.mid, targets.mid, 'Mids (1 kHz)', 1.5);
    eq('highDb', original.high, targets.high, 'Top end (8 kHz)', 1.5);

    if (original.crest !== null) {
      if (original.crest > targets.crest[1]) {
        settings.compress = +Math.min(0.7, 0.15 + (original.crest - targets.crest[1]) * 0.08).toFixed(2);
        steps.push({
          control: 'compress',
          label: 'Glue compression',
          value: `${Math.round(settings.compress * 100)}%`,
          why: `The crest factor is ${original.crest.toFixed(1)} dB (more than ${targets.crest[1]} dB): the loud and soft parts are far apart, so gentle bus compression glues the mix together and gives it a steady, finished feel.`,
        });
      } else if (original.crest < targets.crest[0]) {
        steps.push({
          control: 'compress',
          label: 'Glue compression',
          value: 'off',
          why: `The mix is already dense (${original.crest.toFixed(1)} dB crest, under ${targets.crest[0]} dB): more compression would flatten the punch, so none is added.`,
        });
      }
    }
    if (original.width !== null) {
      if (original.width < -16) {
        settings.width = 1.3;
        steps.push({ control: 'width', label: 'Stereo width', value: '130%', why: `The stereo image is narrow (side ${original.width.toFixed(1)} dB under mid): widened a little so it opens up on headphones, still safe in mono.` });
      } else if (original.width > -4) {
        settings.width = 0.8;
        steps.push({ control: 'width', label: 'Stereo width', value: '80%', why: `The sides are very loud (side ${original.width.toFixed(1)} dB vs mid): narrowed so the vocal and bass stay solid on phones and mono speakers.` });
      }
    }
    steps.push({
      control: 'loudness',
      label: 'Loudness + true-peak limit',
      value: `${input.targetLufs} LUFS, −1 dBTP`,
      why: `Measured at ${original.lufs !== null ? `${original.lufs.toFixed(1)} LUFS` : 'an unknown level'}${original.truePeak !== null ? ` with peaks at ${original.truePeak.toFixed(1)} dBTP` : ''}: brought to ${input.targetLufs} LUFS (the streaming standard) with peaks held under −1 dB, so it plays at the same level as other releases without clipping.`,
    });

    // The real result: the song through the export chain, measured the same way.
    const out = join(dir, 'mastered.wav');
    const chain = [...masterAudioFilters(settings), `loudnorm=I=${input.targetLufs}:TP=-1:LRA=11`, 'aresample=48000'].join(',');
    await ffmpeg(['-t', String(LIMIT_SECONDS), '-i', song, '-vn', '-af', chain, '-c:a', 'pcm_s16le', out]);
    const mastered = await measure(out, input.targetLufs, targets);

    const summary =
      mastered.score > original.score
        ? `Mastered for a ${targets.label} sound: ${original.score}/100 → ${mastered.score}/100. ${steps.length - 1 > 0 ? `${steps.length - 1} desk move${steps.length - 1 === 1 ? '' : 's'} plus` : 'Only'} the loudness and peak stage.`
        : `The mix was already in good shape (${original.score}/100); the master keeps it at ${mastered.score}/100 with only gentle changes.`;
    return { at: new Date().toISOString(), genre: input.genre, targetLufs: input.targetLufs, original, mastered, settings, steps, summary };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
