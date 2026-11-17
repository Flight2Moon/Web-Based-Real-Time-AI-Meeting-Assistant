// Main-thread side of the ASR worker: job queue + scheduling policy.
// Policy: final utterances are never dropped (FIFO). Interim (in-progress) jobs run only
// when the worker is idle and no finals wait, so a slow CPU degrades interim captions
// first instead of accumulating delay.
import type { AudioSegment } from '../audio/segmenter';

export interface AsrResult { text: string; lang: string; ms: number; audioSec: number; waitMs: number }
interface Job { id: number; audio: Float32Array; queuedAt: number; done: (r: AsrResult) => void; fail: (e: Error) => void }

// Whisper emits these on music/noise; they are not speech.
const NON_SPEECH = /^[\s.]*$|^[\[(（♪][^\])）]*[\])）♪]?[\s.]*$/;
export const cleanText = (t: string) => (NON_SPEECH.test(t) ? '' : t);

export class AsrClient {
  private worker: Worker;
  private queue: Job[] = [];
  private interim: Job | null = null;
  private current: Job | null = null;
  private nextId = 1;
  private loaded = false; // jobs queue up (audio is not lost) while the model downloads
  private ready!: { resolve: (ms: number) => void; reject: (e: Error) => void };
  language = 'auto';
  candidates = ['en', 'ko'];
  onProgress: (file: string, loaded: number, total: number) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') this.onProgress(m.file, m.loaded, m.total);
      else if (m.type === 'ready') { this.loaded = true; this.ready.resolve(m.ms); this.pump(); }
      else if (m.type === 'error' && !this.current) this.ready.reject(new Error(m.message));
      else {
        const job = this.current!;
        this.current = null;
        if (m.type === 'error') job.fail(new Error(m.message));
        else job.done({ text: cleanText(m.text), lang: m.lang, ms: m.ms, audioSec: job.audio.length / 16000, waitMs: performance.now() - job.queuedAt - m.ms });
        this.pump();
      }
    };
    this.worker.onerror = (e) => this.ready?.reject(new Error(e.message));
  }

  /** Downloads (cached by the browser afterwards) and initialises the model. Resolves with load time in ms. */
  load(model: string, device: 'webgpu' | 'wasm') {
    return new Promise<number>((resolve, reject) => {
      this.ready = { resolve, reject };
      this.worker.postMessage({ type: 'load', model, device });
    });
  }

  private job(audio: Float32Array) {
    let job!: Job;
    const p = new Promise<AsrResult>((done, fail) => (job = { id: this.nextId++, audio, queuedAt: performance.now(), done, fail }));
    return { job, p };
  }

  transcribe(seg: AudioSegment): Promise<AsrResult> {
    const { job, p } = this.job(seg.audio);
    this.queue.push(job);
    this.pump();
    return p;
  }

  /** Best-effort: resolves null if skipped because the recognizer is busy. */
  transcribeInterim(audio: Float32Array): Promise<AsrResult | null> {
    if (this.current || this.queue.length || !this.loaded) return Promise.resolve(null);
    const { job, p } = this.job(audio);
    this.interim = job;
    this.pump();
    return p;
  }

  get busy() { return !!this.current; }
  /** Seconds of finished speech waiting for the recognizer. Should hover near 0; growth means RTF > 1. */
  get backlogSec() { return this.queue.reduce((n, j) => n + j.audio.length, 0) / 16000; }

  private pump() {
    if (this.current || !this.loaded) return;
    const job = this.queue.shift() ?? this.interim;
    if (!job) return;
    if (job === this.interim) this.interim = null;
    this.current = job;
    this.worker.postMessage({ type: 'run', id: job.id, audio: job.audio, language: this.language, candidates: this.candidates });
  }

  terminate() { this.worker.terminate(); }
}
