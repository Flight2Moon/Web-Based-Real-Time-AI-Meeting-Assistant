/// <reference lib="webworker" />
// Whisper inference via transformers.js (ONNX Runtime Web), isolated in a worker so
// the UI and audio capture never block on inference.
import {
  AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, LogitsProcessor, LogitsProcessorList, type Tensor,
} from '@huggingface/transformers';

let processor: any, tokenizer: any, model: any;
let ids: { sot: number; transcribe: number; notimestamps: number };
const langId = (l: string) => tokenizer.convert_tokens_to_ids(`<|${l}|>`) as number;

// transformers.js has no Whisper language detection (it defaults to English), so for "auto"
// we start decoding from <|startoftranscript|> alone and let the model pick the language
// token itself — restricted to the user's candidate languages — in the same single pass.
class PickLanguage extends LogitsProcessor {
  constructor(private allowed: number[], private forced: number[]) { super(); }
  _call(input_ids: bigint[][], logits: Tensor) {
    const step = input_ids[0].length; // 1 → language, 2 → task, 3 → notimestamps
    if (step > 3) return logits;
    const data = (logits as any)[0].data as Float32Array;
    if (step === 1) { // choose among candidate languages by the model's own scores
      const saved = this.allowed.map((t) => data[t]);
      data.fill(-Infinity);
      this.allowed.forEach((t, i) => (data[t] = saved[i]));
    } else { // force task / notimestamps (Whisper's default suppress list has already masked them, so set, don't restore)
      data.fill(-Infinity);
      data[this.forced[step - 2]] = 0;
    }
    return logits;
  }
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      const t0 = performance.now();
      const progress_callback = (p: any) => p.status === 'progress' && postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      [processor, tokenizer, model] = await Promise.all([
        AutoProcessor.from_pretrained(m.model),
        AutoTokenizer.from_pretrained(m.model),
        WhisperForConditionalGeneration.from_pretrained(m.model, {
          device: m.device,
          // q8 decoder is the standard CPU choice; WebGPU needs float encoder weights.
          dtype: m.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'fp32', decoder_model_merged: 'q8' },
          progress_callback,
        } as any),
      ]);
      ids = {
        sot: tokenizer.convert_tokens_to_ids('<|startoftranscript|>'),
        transcribe: tokenizer.convert_tokens_to_ids('<|transcribe|>'),
        notimestamps: tokenizer.convert_tokens_to_ids('<|notimestamps|>'),
      };
      await run(new Float32Array(16000), 'en', []); // warm-up: compiles shaders / allocates sessions
      postMessage({ type: 'ready', ms: performance.now() - t0 });
    } else if (m.type === 'run') {
      const t0 = performance.now();
      const r = await run(m.audio, m.language, m.candidates);
      postMessage({ type: 'result', id: m.id, ...r, ms: performance.now() - t0 });
    }
  } catch (e) {
    postMessage({ type: 'error', id: m.id, message: (e as Error).message ?? String(e) });
  }
};

async function run(audio: Float32Array, language: string, candidates: string[]) {
  const inputs = await processor(audio);
  const opts: any = { ...inputs, max_new_tokens: 224 };
  if (language === 'auto') {
    opts.decoder_input_ids = [ids.sot];
    opts.logits_processor = new LogitsProcessorList();
    opts.logits_processor.push(new PickLanguage(candidates.map(langId), [ids.transcribe, ids.notimestamps]));
  } else {
    opts.decoder_input_ids = [ids.sot, langId(language), ids.transcribe, ids.notimestamps];
  }
  const out = await model.generate(opts);
  const tokens: number[] = (out.sequences ?? out).tolist()[0].map(Number);
  const lang = (tokenizer.decode([tokens[1]]) as string).replace(/[<|>]/g, '');
  return { text: (tokenizer.decode(tokens, { skip_special_tokens: true }) as string).trim(), lang };
}
