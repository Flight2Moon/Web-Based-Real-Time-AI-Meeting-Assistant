// Context for translation. Two independent mechanisms:
//  1. sentenceChain (on-device): speech is cut on pauses, so a sentence is often split across
//     utterances; translating the pieces separately reads badly. We re-translate the pieces together.
//  2. ContextRefiner (opt-in, Gemini): re-translates recent utterances given the preceding
//     conversation, so pronouns, terminology and tone stay consistent. Sends transcript text to Google.
import type { Segment } from '../types';
import { generateJson } from '../minutes/gemini';

export const endsSentence = (t: string) => /[.?!。？！…]["'”’)\]]*\s*$/.test(t);

/** Utterances (ending at index i) that form one unfinished sentence: same language, short gap, no final punctuation. */
export function sentenceChain(segs: Segment[], i: number, maxLen = 3, maxGapSec = 2): Segment[] {
  const chain = [segs[i]];
  for (let j = i - 1; j >= 0 && chain.length < maxLen; j--) {
    const p = segs[j];
    if (p.lang !== segs[i].lang || endsSentence(p.text) || chain[0].start - p.end > maxGapSec) break;
    chain.unshift(p);
  }
  return chain;
}

const SCHEMA = {
  type: 'ARRAY',
  items: { type: 'OBJECT', properties: { idx: { type: 'INTEGER' }, translation: { type: 'STRING' } }, required: ['idx', 'translation'] },
};
const NAME: Record<string, string> = { ko: 'Korean', en: 'English' };

export const refinePrompt = (context: Segment[], items: Segment[]) =>
  `${context.length ? `Earlier conversation (context only, do NOT translate):\n${context.map((s) => `#${s.idx} ${s.text}`).join('\n')}\n\n` : ''}Translate these utterances:\n${items.map((s) => `#${s.idx} ${s.text}`).join('\n')}`;

export class ContextRefiner {
  private queue: Segment[] = [];
  private busy = false;
  private notBefore = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private o: {
    key: () => string; model: () => string; glossary: () => string; target: string;
    all: () => Segment[]; // full transcript, for context
    onResult: (s: Segment, translation: string, ms: number) => void;
    onError: (e: Error) => void;
    minIntervalMs?: number; // batching window: keeps requests under free-tier per-minute limits
  }) {}

  add(s: Segment) {
    this.queue.push(s);
    this.schedule();
  }

  private schedule() {
    if (this.busy || this.timer || !this.queue.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.run(); }, Math.max(300, this.notBefore - Date.now()));
  }

  private async run() {
    const items = this.queue.splice(0, 12);
    if (!items.length) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      const all = this.o.all();
      const first = all.findIndex((s) => s.idx === items[0].idx);
      const context = all.slice(Math.max(0, first - 6), Math.max(0, first));
      const g = this.o.glossary().trim();
      const out = await generateJson(this.o.key(), this.o.model(),
        `You are a live meeting interpreter. Translate each numbered utterance into natural, fluent ${NAME[this.o.target] ?? this.o.target}, as one consistent conversation.
- Use the earlier conversation to resolve pronouns, omitted subjects, terminology and tone.
- The text comes from speech recognition: fix obvious recognition errors silently, but never add information that was not said.
- An utterance may be a sentence fragment; translate it so it reads naturally after the previous one.
- Utterances already in the target language are returned unchanged.
- Return one item per utterance with its number.${g ? `\nKnown terms / names (keep these spellings):\n${g}` : ''}`,
        refinePrompt(context, items), SCHEMA);
      const ms = performance.now() - t0;
      const byIdx = new Map<number, string>((out as any[]).map((r) => [r.idx, r.translation]));
      for (const s of items) { const t = byIdx.get(s.idx); if (t) this.o.onResult(s, t, ms); }
      this.notBefore = Date.now() + (this.o.minIntervalMs ?? 5000);
    } catch (e) {
      // Rate limited: keep the on-device translation, retry these later. Other errors: drop the batch.
      if ((e as any).rateLimited) { this.queue.unshift(...items); this.notBefore = Date.now() + 30000; }
      this.o.onError(e as Error);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
