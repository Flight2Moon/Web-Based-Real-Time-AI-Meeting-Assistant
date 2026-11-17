import { AudioPipeline } from './audio/pipeline';
import { CaptureError, canCaptureDisplayAudio, captureDisplay, captureMic } from './audio/capture';
import { DEFAULT_OPTS, Segmenter, rms, type AudioSegment } from './audio/segmenter';
import { AsrClient } from './asr/client';
import { createTranslator } from './translate';
import { ContextRefiner, sentenceChain } from './translate/context';
import { DEFAULT_MODEL, generateMinutes, listModels } from './minutes/gemini';
import { db } from './storage/db';
import { applyGlossary, fmtTime, minutesToMarkdown, toJson, toMarkdown, toSrt, toTxt } from './export/formats';
import type { Meeting, Minutes, Segment } from './types';

// ---------- tiny DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = (tag: string, props: Record<string, any> = {}, ...kids: (Node | string)[]) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
};
const ICONS: Record<string, string> = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  settings: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  monitor: '<rect x="2" y="3" width="20" height="14"/><path d="M8 21h8M12 17v4"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  file: '<path d="M14 2H6v20h12V6zM14 2v4h4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  square: '<rect x="5" y="5" width="14" height="14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
};
const setIcon = (el: HTMLElement, name: string) => {
  el.querySelector('svg')?.remove();
  el.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name]}</svg>`);
};
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon!));

// ---------- settings ----------
const KEY = 'ma-gemini-key';
const settings = { lang: 'auto', tgt: '', model: 'onnx-community/whisper-base', device: 'auto', mic: false, refine: false, gmodel: DEFAULT_MODEL, glossary: '', threshold: DEFAULT_OPTS.threshold, minLang: 'ko', ...JSON.parse(localStorage.getItem('ma-settings') ?? '{}') };
const saveSettings = () => localStorage.setItem('ma-settings', JSON.stringify(settings));
const getKey = () => sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY) ?? '';
const bind = (id: string, k: keyof typeof settings) => {
  const el = $<HTMLInputElement>(id);
  if (el.type === 'checkbox') el.checked = settings[k]; else el.value = settings[k];
  el.addEventListener('change', () => { settings[k] = el.type === 'checkbox' ? el.checked : el.value; saveSettings(); });
};
bind('sel-lang', 'lang'); bind('sel-tgt', 'tgt'); bind('sel-model', 'model'); bind('sel-device', 'device'); bind('chk-mic', 'mic'); bind('chk-refine', 'refine'); bind('sel-minlang', 'minLang');

// ---------- state ----------
const translator = createTranslator();
const CANDIDATES = ['en', 'ko'];
let asr: AsrClient | null = null, loadedKey = '', modelReady: Promise<void> = Promise.resolve();
let pipeline: AudioPipeline | null = null, seg = new Segmenter();
let meeting: Meeting | null = null, segments: Segment[] = [];
let live = false, paused = false, pending = 0, utterance = 0, audioSec = 0, level = 0, lastLoud = 0;
let display: MediaStream | null = null, mic: MediaStream | null = null, fileEl: HTMLAudioElement | null = null;
let refiner: ContextRefiner | null = null;
const metrics = { refMs: 0, refN: 0, device: '-', modelLoadMs: 0, asrMs: 0, asrMsSum: 0, audioSecSum: 0, latMs: 0, latSum: 0, n: 0, trMs: 0, trSum: 0, trN: 0, mem: 0 };

const showError = (msg: string) => { $('error').textContent = msg; $('error').hidden = !msg; };
const setProgress = (fraction: number | null, text = '') => {
  $('progress').hidden = fraction === null;
  $('progress-bar').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
  $('progress-text').textContent = text;
};

// ---------- model ----------
async function ensureModel() {
  let device = settings.device as 'auto' | 'webgpu' | 'wasm';
  const auto = device === 'auto';
  if (auto) device = (await (navigator as any).gpu?.requestAdapter().catch(() => null)) ? 'webgpu' : 'wasm';
  const key = `${settings.model}|${device}`;
  if (asr && loadedKey === key) return modelReady;
  const load = (dev: 'webgpu' | 'wasm') => {
    asr?.terminate();
    asr = new AsrClient();
    const files = new Map<string, [number, number]>();
    asr.onProgress = (f, loaded, total) => {
      files.set(f, [loaded, total]);
      const [l, t] = [...files.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0]);
      setProgress(l / t, `모델 다운로드 ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB (최초 1회, 이후 캐시)`);
    };
    setProgress(0, '모델 준비 중…');
    return asr.load(settings.model, dev).then((ms) => { metrics.modelLoadMs = ms; metrics.device = dev; });
  };
  loadedKey = key;
  modelReady = load(device as 'webgpu' | 'wasm')
    .catch((e) => { if (auto && device === 'webgpu') return load('wasm'); throw e; }) // GPU init failed → CPU
    .then(() => setProgress(null), (e) => {
      loadedKey = ''; setProgress(null);
      throw new Error(`음성 인식 모델을 불러오지 못했습니다. 네트워크 연결을 확인하고 다시 시도하세요. (${e.message})`);
    });
  return modelReady;
}

// ---------- session ----------
function attachDisplay(stream: MediaStream) {
  display?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  display = stream;
  pipeline!.setStream('display', stream);
  $<HTMLVideoElement>('preview').srcObject = stream;
  $<HTMLVideoElement>('preview').play().catch(() => {});
  stream.getAudioTracks()[0].onended = () => { // user pressed "stop sharing" or the tab/window closed
    if (display !== stream || !live) return;
    flush();
    pipeline?.setStream('display', null);
    display = null;
    showError('캡처 대상이 종료되었거나 공유가 중지되었습니다. "소스 변경"으로 다시 선택하거나 "종료"를 누르세요.');
    render();
  };
}

async function start(kind: 'display' | 'mic' | 'file', src?: File | string) {
  showError('');
  const refine = !!settings.tgt && settings.refine;
  if (refine && !getKey()) { showError('문맥 번역에는 Gemini API 키가 필요합니다. 설정에서 입력하거나 문맥 번역을 끄세요.'); return $<HTMLDialogElement>('dlg').showModal(); }
  if (settings.tgt && !translator && !refine) return showError('이 브라우저에는 온디바이스 번역이 없습니다. "문맥 번역"(Gemini)을 켜거나 번역을 끄세요.');
  try {
    // Translator first: creating it needs the click's user activation, which getDisplayMedia consumes.
    const sources = settings.lang === 'auto' ? CANDIDATES : [settings.lang];
    const prep = settings.tgt && translator
      ? Promise.all(sources.filter((s) => s !== settings.tgt).map((s) => translator.prepare(s, settings.tgt, (f) => f < 1 && setProgress(f, '번역 언어팩 다운로드 중…'))))
      : Promise.resolve([]);
    prep.catch((e) => showError(e.message)).finally(() => $('progress-text').textContent!.startsWith('번역') && setProgress(null));
    const d = kind === 'display' ? await captureDisplay() : null;
    if (kind === 'mic' || (settings.mic && kind === 'display')) mic = await captureMic();
    pipeline = new AudioPipeline();
    await pipeline.init();
    seg = new Segmenter({ ...DEFAULT_OPTS, threshold: Number(settings.threshold) });
    pipeline.onFrame = onFrame;
    if (d) attachDisplay(d);
    if (mic) pipeline.setStream('mic', mic);
    if (kind === 'file') {
      fileEl = new Audio(typeof src === 'string' ? src : URL.createObjectURL(src!));
      pipeline.setElement('file', fileEl);
      fileEl.onended = () => setTimeout(stop, 1000);
    }
    meeting = { id: crypto.randomUUID(), title: `회의 ${new Date().toLocaleString()}`, createdAt: Date.now(), durationSec: 0 };
    segments = []; audioSec = 0; paused = false; live = true; lastLoud = performance.now();
    const mine = segments; // this meeting's transcript, even if another meeting is opened later
    refiner = refine ? new ContextRefiner({
      key: getKey, model: () => settings.gmodel || DEFAULT_MODEL, glossary: () => settings.glossary, target: settings.tgt, all: () => mine,
      onResult: (s, t, ms) => { metrics.refMs = ms; metrics.refN++; s.refined = true; setTranslation(s, t); },
      onError: (e) => showError(`문맥 번역: ${e.message} 기기 내 번역은 계속됩니다.`),
    }) : null;
    await db.putMeeting(meeting);
    openMeetingView();
    render();
    await ensureModel(); // capture is already running; speech is queued, not lost, while this loads
    if (asr) { asr.language = settings.lang; asr.candidates = CANDIDATES; }
    await fileEl?.play();
  } catch (e) {
    showError(e instanceof CaptureError || e instanceof Error ? e.message : String(e));
    if (live) await stop(); else release();
  }
}

function onFrame(frame: Float32Array) {
  if (!live || paused) return;
  audioSec += frame.length / 16000;
  level = rms(frame);
  if (level >= seg.opts.threshold) lastLoud = performance.now();
  const s = seg.push(frame);
  if (s) finalize(s);
}
const flush = () => { const s = seg.flush(); if (s) finalize(s); };

async function finalize(s: AudioSegment) {
  const endedAt = performance.now(), m = meeting!;
  utterance++;
  $('interim').hidden = true;
  pending++;
  try {
    await modelReady;
    const r = await asr!.transcribe(s);
    metrics.asrMs = r.ms; metrics.asrMsSum += r.ms; metrics.audioSecSum += r.audioSec; metrics.n++;
    metrics.latMs = performance.now() - endedAt; metrics.latSum += metrics.latMs;
    if (!r.text) return;
    const sg: Segment = { id: crypto.randomUUID(), meetingId: m.id, idx: segments.length + 1, start: s.start, end: s.end, lang: r.lang, text: applyGlossary(r.text, settings.glossary) };
    segments.push(sg);
    addRow(sg, true);
    await db.putSegment(sg);
    if (settings.tgt) translateSegment(sg, settings.tgt);
  } catch (e) {
    showError(`전사 오류: ${(e as Error).message}`);
  } finally {
    pending--;
    if (!live && !pending) render();
  }
}


// ---------- translation ----------
async function setTranslation(s: Segment, t: string) {
  s.translation = t;
  await db.putSegment(s);
  const cell = document.querySelector(`.row[data-idx="${s.idx}"] .tr`);
  if (cell && s.meetingId === meeting?.id) cell.textContent = t;
}

// Never awaited by the transcription path. Stage 1 (on-device, instant): translate the utterance together with
// the unfinished sentence it continues. Stage 2 (optional, Gemini): refine with conversation context.
function translateSegment(sg: Segment, tgt: string) {
  if (translator && sg.lang !== tgt) {
    const chain = sentenceChain(segments, segments.indexOf(sg));
    const t0 = performance.now();
    translator.translate(chain.map((s) => s.text).join(' '), sg.lang, tgt).then(async (t) => {
      metrics.trMs = performance.now() - t0; metrics.trSum += metrics.trMs; metrics.trN++;
      if (sg.refined) return; // the contextual result already arrived
      for (const p of chain.slice(0, -1)) if (!p.refined) await setTranslation(p, ''); // merged into the row below
      await setTranslation(sg, t);
    }).catch((e) => showError(`번역 실패: ${e.message}`));
  }
  if (sg.lang !== tgt) refiner?.add(sg); // same-language utterances still serve as context
}

// Interim captions: only when the recognizer has spare capacity.
setInterval(() => {
  if (!live || paused || !seg.active || seg.partialMs() < 1000 || !asr || asr.busy || asr.backlogSec) return;
  const u = utterance;
  asr.transcribeInterim(seg.partial()!).then((r) => {
    if (!r || u !== utterance || !seg.active) return;
    $('interim').hidden = !r.text;
    $('interim').querySelector('.ts')!.textContent = fmtTime(audioSec);
    $('interim').querySelector('.orig')!.textContent = r.text;
    const tr = $('interim').querySelector('.tr')!;
    if (r.text && settings.tgt && translator && r.lang !== settings.tgt)
      translator.translate(r.text, r.lang, settings.tgt).then((t) => { if (u === utterance) tr.textContent = t; }).catch(() => {});
    else tr.textContent = '';
    $('empty').hidden = true;
  }).catch(() => {});
}, 400);

function release() {
  for (const s of [display, mic]) s?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  display = mic = null;
  fileEl?.pause(); fileEl = null;
  $<HTMLVideoElement>('preview').srcObject = null;
  pipeline?.close(); pipeline = null;
}

async function stop() {
  if (!live) return;
  flush();
  live = false; paused = false;
  release(); // stops all tracks → browser sharing indicator disappears
  meeting!.durationSec = audioSec;
  await db.putMeeting(meeting!);
  render();
}

$('btn-capture').onclick = () => start('display');
$('btn-mic').onclick = () => start('mic');
const demoUrl = new URLSearchParams(location.search).get('file'); // e.g. ?file=/tests/samples/en.wav
$('btn-file').onclick = () => (demoUrl ? start('file', demoUrl) : $('file').click());
$<HTMLInputElement>('file').onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) start('file', f); (e.target as HTMLInputElement).value = ''; };
$('btn-preload').onclick = () => ensureModel().then(() => showError(''), (e) => showError(e.message));
$('btn-stop').onclick = stop;
$('btn-pause').onclick = async () => {
  paused = !paused;
  if (paused) { flush(); fileEl?.pause(); await pipeline?.pause(); } else { await pipeline?.resume(); await fileEl?.play(); lastLoud = performance.now(); }
  render();
};
$('btn-source').onclick = async () => {
  try { const d = await captureDisplay(); flush(); attachDisplay(d); showError(''); render(); } catch (e) { showError((e as Error).message); }
};
$('btn-new').onclick = () => { if (!live) { meeting = null; segments = []; render(); } };
$<HTMLInputElement>('title').onchange = async (e) => { if (meeting) { meeting.title = (e.target as HTMLInputElement).value || meeting.title; await db.putMeeting(meeting); renderList(); } };
addEventListener('beforeunload', (e) => { if (live || pending) e.preventDefault(); });

// ---------- rendering ----------
function addRow(s: Segment, scroll = false) {
  const save = (field: 'text' | 'translation') => async (e: Event) => {
    const v = (e.target as HTMLElement).textContent ?? '';
    if (v !== (s[field] ?? '')) { s[field] = v; await db.putSegment(s); }
  };
  const row = h('div', { className: 'row' },
    h('span', { className: 'ts mono', textContent: fmtTime(s.start), title: `#${s.idx} · ${s.lang}` }),
    h('div', { className: 'orig', contentEditable: 'plaintext-only', textContent: s.text, onblur: save('text') }),
    h('div', { className: 'tr', contentEditable: 'plaintext-only', textContent: s.translation ?? '', onblur: save('translation') }));
  row.dataset.idx = String(s.idx);
  $('rows').append(row);
  $('empty').hidden = true;
  if (scroll && innerHeight + scrollY > document.body.scrollHeight - 300) row.scrollIntoView({ block: 'end' });
}

function openMeetingView() {
  $('rows').replaceChildren();
  $('empty').hidden = segments.length > 0;
  $('interim').hidden = true;
  $<HTMLInputElement>('search').value = '';
  segments.forEach((s) => addRow(s));
  renderMinutes();
  setTab('transcript');
}

async function renderList() {
  const list = await db.meetings();
  $('meetings').replaceChildren(...list.map((m) => {
    const li = h('li', { className: m.id === meeting?.id ? 'active' : '', tabIndex: 0 }, m.title, h('small', { className: 'mono muted', textContent: `${new Date(m.createdAt).toLocaleDateString()} · ${fmtTime(m.durationSec)}` }));
    li.onclick = li.onkeydown = async (e: Event) => {
      if (live || pending || (e instanceof KeyboardEvent && e.key !== 'Enter')) return;
      meeting = m; segments = await db.segments(m.id);
      openMeetingView(); render();
    };
    return li;
  }));
}

function render() {
  const busy = live || pending > 0;
  $('setup').hidden = busy || !!meeting;
  $('live').hidden = !live;
  $('meeting').hidden = !meeting;
  $('dot').className = `dot ${live ? (paused || (!display && !mic && !fileEl) ? 'paused' : 'live') : ''}`;
  const noSource = live && !display && !mic && !fileEl;
  $('state').textContent = live ? (paused ? '일시정지' : noSource ? '소스 없음' : '캡처 중') : pending ? '남은 발화 처리 중' : '대기';
  $('btn-pause').lastChild!.textContent = paused ? '재개' : '일시정지';
  setIcon($('btn-pause'), paused ? 'play' : 'pause');
  $('btn-source').hidden = !!fileEl;
  $<HTMLInputElement>('title').value = meeting?.title ?? '';
  $<HTMLButtonElement>('btn-new').disabled = busy;
  $<HTMLButtonElement>('btn-delete').disabled = busy;
  $<HTMLButtonElement>('btn-minutes').disabled = busy;
  $('rows').parentElement!.classList.toggle('notr-all', !settings.tgt && !segments.some((s) => s.translation));
  renderList();
}

setInterval(() => {
  if (live) {
    const quiet = !paused && performance.now() - lastLoud > 15000;
    $('live-meta').textContent = `${fmtTime(audioSec)} · 입력 레벨 ${level.toFixed(3)} · 대기 ${asr?.backlogSec.toFixed(1) ?? 0}s` + (quiet ? ' · 소리가 감지되지 않습니다 — 공유 대상과 "오디오 공유" 설정을 확인하세요' : '');
  }
  const avg = (s: number, n: number) => (n ? s / n : 0);
  (performance as any).measureUserAgentSpecificMemory?.().then((r: any) => (metrics.mem = r.bytes)).catch(() => {});
  const rows: [string, string][] = [
    ['장치', `${metrics.device} · ${crossOriginIsolated ? navigator.hardwareConcurrency + ' threads' : 'single-thread'}`],
    ['모델 로딩', `${(metrics.modelLoadMs / 1000).toFixed(1)} s`],
    ['ASR 처리 (최근)', `${metrics.asrMs.toFixed(0)} ms`],
    ['Real-Time Factor (평균)', avg(metrics.asrMsSum / 1000, metrics.audioSecSum).toFixed(3)],
    ['발화 종료→자막 (최근/평균)', `${metrics.latMs.toFixed(0)} / ${avg(metrics.latSum, metrics.n).toFixed(0)} ms`],
    ['번역 (최근/평균)', `${metrics.trMs.toFixed(0)} / ${avg(metrics.trSum, metrics.trN).toFixed(0)} ms`],
    ['문맥 번역 (최근 · 횟수)', `${metrics.refMs.toFixed(0)} ms · ${metrics.refN}`],
    ['오디오 대기열', `${asr?.backlogSec.toFixed(1) ?? '0.0'} s`],
    ['메모리', metrics.mem ? `${(metrics.mem / 1e6).toFixed(0)} MB` : `${(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6).toFixed(0)} MB (JS heap)`],
  ];
  $('metrics').replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', { textContent: k }), h('dd', { textContent: v }))));
}, 1000);
(window as any).__metrics = metrics; // for benchmarking from the console

// ---------- tabs / search / export / delete ----------
function setTab(name: string) {
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-transcript').hidden = name !== 'transcript';
  $('tab-minutes').hidden = name !== 'minutes';
}
document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab!)));
$('search').oninput = (e) => {
  const q = (e.target as HTMLInputElement).value.toLowerCase();
  document.querySelectorAll<HTMLElement>('#rows .row').forEach((r) => (r.hidden = !!q && !r.textContent!.toLowerCase().includes(q)));
};
const download = (name: string, text: string, type: string) => {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
document.querySelectorAll<HTMLElement>('[data-export]').forEach((b) => (b.onclick = () => {
  if (!meeting) return;
  const name = meeting.title.replace(/[\\/:*?"<>|]/g, '_');
  const f = b.dataset.export!;
  if (f === 'txt') download(`${name}.txt`, toTxt(meeting, segments), 'text/plain');
  if (f === 'md') download(`${name}.md`, toMarkdown(meeting, segments), 'text/markdown');
  if (f === 'srt') download(`${name}.srt`, toSrt(segments), 'application/x-subrip');
  if (f === 'json') download(`${name}.json`, toJson(meeting, segments), 'application/json');
}));
$('btn-print').onclick = () => print(); // browser "Save as PDF"; prints the active tab
$('btn-delete').onclick = async () => {
  if (!meeting || !confirm(`"${meeting.title}" 회의의 전사·번역·회의록을 이 브라우저에서 영구 삭제합니다. 되돌릴 수 없습니다.`)) return;
  await db.deleteMeeting(meeting.id);
  meeting = null; segments = [];
  render();
};

// ---------- minutes ----------
function renderMinutes() {
  const x = meeting?.minutes, root = $('minutes');
  root.replaceChildren();
  if (!x || !meeting) return;
  const cite = (e: number[]) => e.map((i) => h('button', { className: 'ev', textContent: `#${i}`, title: '근거 발화로 이동', onclick: () => {
    setTab('transcript');
    const row = document.querySelector<HTMLElement>(`.row[data-idx="${i}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.classList.add('hit');
    setTimeout(() => row?.classList.remove('hit'), 2500);
  } }));
  const unsure = (u: boolean) => (u ? [h('span', { className: 'tag', textContent: '불확실' })] : []);
  const ul = (items: (Node | string)[][]) => (items.length ? h('ul', {}, ...items.map((i) => h('li', {}, ...i))) : h('p', { className: 'muted', textContent: '없음' }));
  root.append(
    h('h1', { textContent: x.title || meeting.title }),
    h('p', { className: 'mono muted', textContent: `${new Date(meeting.createdAt).toLocaleString()} · ${fmtTime(meeting.durationSec)}` }),
    h('h2', { textContent: 'Overall Summary' }), h('p', { textContent: x.summary }),
    h('h2', { textContent: 'Main Discussion Topics' }), ...x.topics.flatMap((t) => [h('h3', {}, t.title, ...cite(t.evidence)), ul(t.points.map((p) => [p]))]),
    h('h2', { textContent: 'Key Decisions' }), ul(x.decisions.map((d) => [d.text, ...unsure(d.uncertain), ...cite(d.evidence)])),
    h('h2', { textContent: 'Action Items' }), ul(x.actionItems.map((a) => [`${a.task} — 담당: ${a.owner ?? '미정'}${a.due ? ` · 기한: ${a.due}` : ''}`, ...unsure(a.uncertain), ...cite(a.evidence)])),
    h('h2', { textContent: 'Open Questions' }), ul(x.openQuestions.map((q) => [q.text, ...cite(q.evidence)])),
    h('h2', { textContent: 'Follow-up Tasks' }), ul(x.followUps.map((q) => [q.text, ...cite(q.evidence)])),
    h('p', { className: 'muted small', textContent: `AI 생성 (${x.model}, ${new Date(x.generatedAt).toLocaleString()}). 번호를 눌러 근거 발화를 확인하세요. 전사 오류가 반영될 수 있습니다.` }),
    h('div', { className: 'actions' }, h('button', { className: 'ghost', textContent: '회의록 MD 저장', onclick: () => download(`${meeting!.title}-minutes.md`, minutesToMarkdown(meeting!, x), 'text/markdown') })),
  );
}
$('btn-minutes').onclick = async () => {
  if (!meeting) return;
  if (!segments.length) return showError('전사된 내용이 없어 회의록을 만들 수 없습니다.');
  if (!getKey()) { showError('회의록 생성에는 Gemini API 키가 필요합니다. 설정에서 입력하세요.'); return $<HTMLDialogElement>('dlg').showModal(); }
  const btn = $<HTMLButtonElement>('btn-minutes'), m = meeting;
  btn.disabled = true; showError('');
  try {
    m.minutes = (await generateMinutes({
      key: getKey(), model: settings.gmodel || DEFAULT_MODEL, lang: settings.minLang, glossary: settings.glossary, meeting: m, segments,
      onProgress: (d, t) => setProgress(d / t, `회의록 생성 중… (${d + 1}/${t})`),
    })) as Minutes;
    await db.putMeeting(m);
    if (meeting === m) renderMinutes();
  } catch (e) {
    showError((e as Error).message);
  } finally {
    btn.disabled = false; setProgress(null);
  }
};

// ---------- settings dialog ----------
$('btn-settings').onclick = () => {
  $<HTMLInputElement>('key').value = getKey();
  $<HTMLInputElement>('remember').checked = !!localStorage.getItem(KEY);
  $<HTMLInputElement>('gmodel').value = settings.gmodel;
  $<HTMLTextAreaElement>('glossary').value = settings.glossary;
  $<HTMLInputElement>('thr').value = settings.threshold;
  $('thr-val').textContent = String(settings.threshold);
  $('key-status').textContent = '';
  $<HTMLDialogElement>('dlg').showModal();
};
$('thr').oninput = (e) => ($('thr-val').textContent = (e.target as HTMLInputElement).value);
$('btn-models').onclick = async () => {
  try {
    const models = await listModels($<HTMLInputElement>('key').value.trim());
    $('gmodels').replaceChildren(...models.map((m) => h('option', { value: m })));
    $('key-status').textContent = `키 확인 완료 · 사용 가능 모델 ${models.length}개`;
  } catch (e) { $('key-status').textContent = (e as Error).message; }
};
$<HTMLDialogElement>('dlg').onclose = () => {
  const key = $<HTMLInputElement>('key').value.trim();
  sessionStorage.removeItem(KEY); localStorage.removeItem(KEY);
  if (key) ($<HTMLInputElement>('remember').checked ? localStorage : sessionStorage).setItem(KEY, key);
  settings.gmodel = $<HTMLInputElement>('gmodel').value.trim() || DEFAULT_MODEL;
  settings.glossary = $<HTMLTextAreaElement>('glossary').value;
  settings.threshold = Number($<HTMLInputElement>('thr').value);
  seg.opts.threshold = settings.threshold;
  saveSettings();
};

// ---------- boot ----------
// GitHub Pages can't send COOP/COEP headers; a service worker adds them (one reload on first visit).
if (!crossOriginIsolated && 'serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('coi-sw.js').then((reg) => {
    if (navigator.serviceWorker.controller) return;
    if (reg.active) location.reload(); else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }).catch(() => {});
}
const notes: string[] = [];
if (!canCaptureDisplayAudio()) {
  $<HTMLButtonElement>('btn-capture').disabled = true;
  notes.push('이 브라우저는 탭/창 오디오 캡처를 지원하지 않습니다. 데스크톱 Chrome 또는 Edge에서 열거나, 마이크·녹음 파일 전사를 사용하세요.');
}
if (!translator) notes.push('이 브라우저에는 온디바이스 번역(Translator API, Chrome/Edge 138+ 데스크톱)이 없습니다. 번역하려면 "문맥 번역"(Gemini)을 켜세요.');
$('support').textContent = notes.join('\n'); $('support').hidden = !notes.length;
$('env').textContent = `${crossOriginIsolated ? 'multi-thread' : 'single-thread'} · WebGPU ${'gpu' in navigator ? 'available' : 'n/a'}`;
render();
