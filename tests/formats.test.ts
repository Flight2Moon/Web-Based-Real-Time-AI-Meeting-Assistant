import { expect, test } from 'vitest';
import { applyGlossary, fmtTime, toSrt, toTxt, toMarkdown, toJson } from '../src/export/formats';
import { chunkSegments, formatTranscript } from '../src/minutes/gemini';
import { cleanText } from '../src/asr/client';
import type { Meeting, Segment } from '../src/types';

const m: Meeting = { id: 'm', title: 'Sync', createdAt: 0, durationSec: 3725 };
const seg = (idx: number, start: number, text: string, translation?: string): Segment =>
  ({ id: `s${idx}`, meetingId: 'm', idx, start, end: start + 2.5, lang: 'en', text, translation });
const segs = [seg(1, 0, 'Hello', '안녕하세요'), seg(2, 3661.25, 'Bye')];

test('time formatting', () => expect(fmtTime(3725)).toBe('01:02:05'));

test('srt', () => {
  expect(toSrt(segs)).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello\n안녕하세요\n\n2\n01:01:01,250 --> 01:01:03,750\nBye\n');
});

test('txt / markdown / json keep text, translation and timestamps', () => {
  expect(toTxt(m, segs)).toContain('[01:01:01] Bye');
  expect(toTxt(m, segs)).toContain('→ 안녕하세요');
  expect(toMarkdown(m, segs)).toContain('**#1 [00:00:00]** Hello');
  expect(JSON.parse(toJson(m, segs)).segments[1].text).toBe('Bye');
});

test('glossary replacements', () => expect(applyGlossary('we use web gpu', 'web gpu => WebGPU\nKubernetes')).toBe('we use WebGPU'));

test('non-speech outputs are dropped', () => {
  for (const t of ['', ' . ', '[BLANK_AUDIO]', '(music)', '♪♪']) expect(cleanText(t)).toBe('');
  expect(cleanText('Okay (laughs) fine.')).toBe('Okay (laughs) fine.');
});

test('transcript chunking covers every utterance exactly once, in order', () => {
  const many = Array.from({ length: 50 }, (_, i) => seg(i + 1, i, 'x'.repeat(80)));
  const chunks = chunkSegments(many, 1000);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flat().map((s) => s.idx)).toEqual(many.map((s) => s.idx));
  for (const c of chunks) expect(formatTranscript(c).length).toBeLessThanOrEqual(1100);
});
