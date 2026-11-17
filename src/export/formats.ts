import type { Meeting, Minutes, Segment } from '../types';

const p2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
export const fmtTime = (sec: number) => `${p2(sec / 3600)}:${p2((sec % 3600) / 60)}:${p2(sec % 60)}`;
const srtTime = (sec: number) => `${fmtTime(sec)},${String(Math.round((sec % 1) * 1000) % 1000).padStart(3, '0')}`;
const header = (m: Meeting) => `${new Date(m.createdAt).toLocaleString()} · ${fmtTime(m.durationSec)}`;

export const toTxt = (m: Meeting, segs: Segment[]) =>
  [m.title, header(m), '', ...segs.map((s) => `[${fmtTime(s.start)}] ${s.text}${s.translation ? `\n    → ${s.translation}` : ''}`)].join('\n') + '\n';

export const toSrt = (segs: Segment[]) =>
  segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${s.text}${s.translation ? `\n${s.translation}` : ''}\n`).join('\n');

export const toJson = (m: Meeting, segs: Segment[]) =>
  JSON.stringify({ meeting: m, segments: segs.map(({ id, meetingId, ...s }) => s) }, null, 2);

const ev = (e: number[]) => (e?.length ? ` _(근거: ${e.map((i) => `#${i}`).join(', ')})_` : '');
const unsure = (u: boolean) => (u ? ' [불확실]' : '');
const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (없음)');

export const minutesToMarkdown = (m: Meeting, x: Minutes) => [
  `# ${x.title || m.title}`, '', `**Date and Duration:** ${header(m)}`, '',
  '## Overall Summary', '', x.summary, '',
  '## Main Discussion Topics', '', ...x.topics.map((t) => `### ${t.title}${ev(t.evidence)}\n\n${list(t.points)}\n`),
  '## Key Decisions', '', list(x.decisions.map((d) => d.text + unsure(d.uncertain) + ev(d.evidence))), '',
  '## Action Items', '', list(x.actionItems.map((a) => `${a.task} — 담당: ${a.owner ?? '미정'}${a.due ? `, 기한: ${a.due}` : ''}${unsure(a.uncertain)}${ev(a.evidence)}`)), '',
  '## Open Questions', '', list(x.openQuestions.map((q) => q.text + ev(q.evidence))), '',
  '## Follow-up Tasks', '', list(x.followUps.map((q) => q.text + ev(q.evidence))), '',
  `_AI 생성 회의록 (${x.model}). 근거 번호는 전사 발화 번호입니다. 원문과 대조해 확인하세요._`, '',
].join('\n');

export const toMarkdown = (m: Meeting, segs: Segment[]) => [
  m.minutes ? minutesToMarkdown(m, m.minutes) : `# ${m.title}\n\n${header(m)}\n`,
  '## Transcript', '',
  ...segs.map((s) => `**#${s.idx} [${fmtTime(s.start)}]** ${s.text}${s.translation ? `  \n> ${s.translation}` : ''}\n`),
].join('\n');

/** Glossary lines of the form `wrong => right` are applied to recognized text. */
export function applyGlossary(text: string, glossary: string) {
  for (const line of glossary.split('\n')) {
    const [from, to] = line.split('=>').map((s) => s.trim());
    if (from && to) text = text.replaceAll(from, to);
  }
  return text;
}
