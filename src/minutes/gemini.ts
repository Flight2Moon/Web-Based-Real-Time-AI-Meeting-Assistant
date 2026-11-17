// Meeting minutes via the user's own Gemini API key. This is the ONLY module that sends
// meeting content off the device: transcript text → generativelanguage.googleapis.com.
import type { Meeting, Minutes, Segment } from '../types';
import { fmtTime } from '../export/formats';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';
const MAX_CHARS = 120_000; // per request; longer transcripts are summarised in parts then merged

export class GeminiError extends Error {}

async function call(path: string, key: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, // header, not URL: keeps the key out of logs/history
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GeminiError('Gemini API에 연결할 수 없습니다. 네트워크를 확인하세요.');
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const msg = json.error?.message ?? res.statusText;
  if (res.status === 429) throw new GeminiError(`API 사용량 한도를 초과했습니다. 잠시 후 다시 시도하세요. (${msg})`);
  if (res.status === 400 && /API key/i.test(msg) || res.status === 401 || res.status === 403) throw new GeminiError(`API 키가 올바르지 않거나 권한이 없습니다. (${msg})`);
  if (res.status === 404) throw new GeminiError(`모델을 찾을 수 없습니다. 설정에서 모델 이름을 확인하세요. (${msg})`);
  throw new GeminiError(`Gemini API 오류 ${res.status}: ${msg}`);
}

export async function listModels(key: string): Promise<string[]> {
  const j = await call('models?pageSize=200', key);
  return (j.models ?? [])
    .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m: any) => (m.name as string).replace('models/', ''));
}

const S = (description?: string) => ({ type: 'STRING', description });
const EVIDENCE = { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Utterance numbers (#N) that directly support this item' };
const arr = (properties: Record<string, unknown>, required: string[]) => ({ type: 'ARRAY', items: { type: 'OBJECT', properties: { ...properties, evidence: EVIDENCE }, required: [...required, 'evidence'] } });
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: S(), summary: S(),
    topics: arr({ title: S(), points: { type: 'ARRAY', items: S() } }, ['title', 'points']),
    decisions: arr({ text: S(), uncertain: { type: 'BOOLEAN' } }, ['text', 'uncertain']),
    actionItems: arr({ task: S(), owner: { ...S('Only if explicitly named in the transcript'), nullable: true }, due: { ...S(), nullable: true }, uncertain: { type: 'BOOLEAN' } }, ['task', 'uncertain']),
    openQuestions: arr({ text: S() }, ['text']),
    followUps: arr({ text: S() }, ['text']),
  },
  required: ['title', 'summary', 'topics', 'decisions', 'actionItems', 'openQuestions', 'followUps'],
};

const rules = (lang: string, glossary: string) => `You write meeting minutes strictly from an automatic speech recognition transcript.
Rules:
- Use ONLY what is said in the transcript. Never invent decisions, owners, dates or numbers.
- A "decision" must have been explicitly agreed in the transcript. If nothing was decided, return an empty list.
- Set owner/due to null unless explicitly stated. Never guess an owner.
- If something is ambiguous or may be a recognition error, set uncertain=true and say so in the text.
- Every item must cite the utterance numbers (#N) it is based on in "evidence".
- The transcript may contain recognition errors and mixed Korean/English; interpret cautiously.
- Write all output text in ${lang === 'ko' ? 'Korean' : 'English'}.${glossary.trim() ? `\nKnown terms / names (prefer these spellings):\n${glossary}` : ''}`;

export const formatTranscript = (segs: Segment[]) => segs.map((s) => `#${s.idx} [${fmtTime(s.start)}] ${s.text}`).join('\n');

/** Split into consecutive groups whose formatted size stays under maxChars. */
export function chunkSegments(segs: Segment[], maxChars = MAX_CHARS): Segment[][] {
  const out: Segment[][] = [[]];
  let size = 0;
  for (const s of segs) {
    const n = s.text.length + 20;
    if (size + n > maxChars && out.at(-1)!.length) { out.push([]); size = 0; }
    out.at(-1)!.push(s);
    size += n;
  }
  return out;
}

async function generate(key: string, model: string, system: string, user: string) {
  const j = await call(`models/${model}:generateContent`, key, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  const text = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('');
  if (!text) throw new GeminiError(`모델이 응답을 생성하지 못했습니다 (${j.candidates?.[0]?.finishReason ?? j.promptFeedback?.blockReason ?? 'empty'}).`);
  try { return JSON.parse(text); } catch { throw new GeminiError('모델 응답을 해석할 수 없습니다. 다시 시도하세요.'); }
}

export async function generateMinutes(
  o: { key: string; model: string; lang: string; glossary: string; meeting: Meeting; segments: Segment[]; onProgress?: (done: number, total: number) => void },
): Promise<Minutes> {
  const sys = rules(o.lang, o.glossary);
  const chunks = chunkSegments(o.segments);
  const total = chunks.length + (chunks.length > 1 ? 1 : 0);
  const parts = [];
  for (const [i, c] of chunks.entries()) { // sequential: gentle on free-tier rate limits
    o.onProgress?.(i, total);
    parts.push(await generate(o.key, o.model, sys, `Meeting transcript${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}:\n\n${formatTranscript(c)}`));
  }
  let result = parts[0];
  if (parts.length > 1) {
    o.onProgress?.(chunks.length, total);
    result = await generate(o.key, o.model, sys,
      `Below are minutes of consecutive parts of ONE meeting, as JSON. Merge them into a single set of minutes. Keep evidence numbers. Do not add anything not present in the parts.\n\n${JSON.stringify(parts)}`);
  }
  // Drop citations to utterances that don't exist.
  const valid = new Set(o.segments.map((s) => s.idx));
  for (const k of ['topics', 'decisions', 'actionItems', 'openQuestions', 'followUps'] as const)
    for (const item of (result[k] ??= [])) item.evidence = (item.evidence ?? []).filter((n: number) => valid.has(n));
  return { ...result, model: o.model, generatedAt: Date.now() };
}
