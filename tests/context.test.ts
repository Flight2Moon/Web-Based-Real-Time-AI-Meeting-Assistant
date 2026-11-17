import { expect, test } from 'vitest';
import { endsSentence, refinePrompt, sentenceChain } from '../src/translate/context';
import type { Segment } from '../src/types';

const seg = (idx: number, start: number, end: number, text: string, lang = 'en'): Segment => ({ id: `s${idx}`, meetingId: 'm', idx, start, end, lang, text });

test('sentence end detection (en/ko, quotes)', () => {
  for (const t of ['Done.', 'Really?', '끝났습니다.', 'He said "go."', '그래요!']) expect(endsSentence(t)).toBe(true);
  for (const t of ['and the base model', '그래서 우리는', 'First,']) expect(endsSentence(t)).toBe(false);
});

test('chains utterances of one unfinished sentence only', () => {
  const s = [
    seg(1, 0, 3, 'We finished the benchmark.'),
    seg(2, 3.3, 8, 'The base model runs faster than real time'),
    seg(3, 8.2, 10, 'on a laptop.'),
    seg(4, 10.5, 12, '그리고', 'ko'),
    seg(5, 20, 22, '다음 주에 배포합니다.', 'ko'),
  ];
  expect(sentenceChain(s, 2).map((x) => x.idx)).toEqual([2, 3]); // stops at the finished sentence #1
  expect(sentenceChain(s, 1).map((x) => x.idx)).toEqual([2]);
  expect(sentenceChain(s, 3).map((x) => x.idx)).toEqual([4]); // language change breaks the chain
  expect(sentenceChain(s, 4).map((x) => x.idx)).toEqual([5]); // long gap breaks the chain
});

test('refine prompt separates context from items', () => {
  const p = refinePrompt([seg(1, 0, 1, 'Jiheon owns the guide.')], [seg(2, 1, 2, 'He will finish it Wednesday.')]);
  expect(p).toContain('context only');
  expect(p.indexOf('#1 Jiheon')).toBeLessThan(p.indexOf('Translate these utterances'));
  expect(p).toMatch(/Translate these utterances:\n#2 He will/);
});
