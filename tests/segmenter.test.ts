import { expect, test } from 'vitest';
import { Segmenter, DEFAULT_OPTS } from '../src/audio/segmenter';

const frame = (amp: number) => new Float32Array(1600).fill(amp); // 100 ms
const feed = (s: Segmenter, amp: number, n: number) => {
  const out = [];
  for (let i = 0; i < n; i++) { const r = s.push(frame(amp)); if (r) out.push(r); }
  return out;
};

test('emits one utterance after speech followed by silence, with preroll and timestamps', () => {
  const s = new Segmenter();
  expect(feed(s, 0, 10)).toEqual([]); // 1 s silence
  expect(feed(s, 0.1, 20)).toEqual([]); // 2 s speech
  const [seg] = feed(s, 0, 10);
  expect(seg.start).toBeCloseTo(0.7); // 300 ms preroll before onset at 1.0 s
  expect(seg.end).toBeCloseTo(3.6); // 600 ms trailing silence
  expect(seg.audio.length).toBe(Math.round((seg.end - seg.start) * 16000));
});

test('silence only never emits; short blips are dropped', () => {
  const s = new Segmenter();
  expect(feed(s, 0, 100)).toEqual([]);
  feed(s, 0.1, 1);
  expect(feed(s, 0, 20)).toEqual([]);
});

test('continuous speech is hard-cut at maxMs so jobs stay bounded', () => {
  const s = new Segmenter();
  const out = feed(s, 0.1, 400); // 40 s nonstop
  expect(out.length).toBe(2);
  for (const seg of out) expect(seg.audio.length).toBeLessThanOrEqual((DEFAULT_OPTS.maxMs / 1000) * 16000);
});

test('flush returns the in-progress utterance', () => {
  const s = new Segmenter();
  feed(s, 0.1, 10);
  expect(s.partialMs()).toBe(1000);
  expect(s.flush()?.audio.length).toBe(16000);
  expect(s.flush()).toBeNull();
});
