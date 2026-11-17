// Splits a continuous PCM stream into utterances on silence. Pure logic, no browser APIs.
// ponytail: energy (RMS) VAD — fine for clean digital tab audio; swap for Silero VAD if
// noisy microphone input causes false triggers. `threshold` is the calibration knob.
export interface SegmenterOpts {
  sampleRate: number;
  threshold: number; // RMS above this counts as speech
  minSilenceMs: number; // silence that ends an utterance
  softMaxMs: number; // past this length a shorter pause (minSilence/3) ends it
  maxMs: number; // hard cut — keeps ASR cost per job bounded
  prerollMs: number; // audio kept before speech onset
  minSpeechMs: number; // utterances with less speech are dropped as noise
}

export const DEFAULT_OPTS: SegmenterOpts = {
  sampleRate: 16000, threshold: 0.008, minSilenceMs: 600, softMaxMs: 7000, maxMs: 15000, prerollMs: 300, minSpeechMs: 250,
};

export interface AudioSegment { audio: Float32Array; start: number; end: number } // seconds

export const rms = (f: Float32Array) => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / (f.length || 1));
};

const concat = (chunks: Float32Array[]) => {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

export class Segmenter {
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private len = 0; // samples in current utterance
  private speech = 0;
  private silence = 0;
  private total = 0; // samples seen so far
  private startSample = 0;
  active = false;

  constructor(public opts: SegmenterOpts = DEFAULT_OPTS) {}

  private ms(samples: number) { return (samples / this.opts.sampleRate) * 1000; }

  /** Feed one frame; returns a finished utterance when one ends. */
  push(frame: Float32Array): AudioSegment | null {
    const o = this.opts;
    const loud = rms(frame) >= o.threshold;
    let out: AudioSegment | null = null;
    if (!this.active) {
      if (loud) {
        const pre = this.preroll.reduce((n, c) => n + c.length, 0);
        this.chunks = [...this.preroll, frame];
        this.preroll = [];
        this.len = pre + frame.length;
        this.startSample = this.total - pre;
        this.speech = frame.length;
        this.silence = 0;
        this.active = true;
      } else {
        this.preroll.push(frame);
        while (this.ms(this.preroll.reduce((n, c) => n + c.length, 0) - this.preroll[0].length) >= o.prerollMs) this.preroll.shift();
      }
    } else {
      this.chunks.push(frame);
      this.len += frame.length;
      if (loud) { this.speech += frame.length; this.silence = 0; } else this.silence += frame.length;
      const need = this.ms(this.len) > o.softMaxMs ? o.minSilenceMs / 3 : o.minSilenceMs;
      if (this.ms(this.silence) >= need || this.ms(this.len) >= o.maxMs) out = this.end(frame.length);
    }
    this.total += frame.length;
    return out;
  }

  /** Force-finish the current utterance (pause / stop / source change). */
  flush(): AudioSegment | null { return this.active ? this.end(0) : null; }

  /** Audio of the utterance in progress, for interim transcription. */
  partial(): Float32Array | null { return this.active ? concat(this.chunks) : null; }
  partialMs() { return this.active ? this.ms(this.len) : 0; }

  private end(pending: number): AudioSegment | null {
    const ok = this.ms(this.speech) >= this.opts.minSpeechMs;
    const seg = ok ? {
      audio: concat(this.chunks),
      start: this.startSample / this.opts.sampleRate,
      end: (this.total + pending) / this.opts.sampleRate,
    } : null;
    this.chunks = []; this.len = 0; this.active = false;
    return seg;
  }
}
