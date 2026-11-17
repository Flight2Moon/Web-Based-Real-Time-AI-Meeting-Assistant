// Translation boundary. Current engine: Chrome/Edge built-in Translator API (on-device,
// Chrome 138+ desktop). To add an engine, implement `Translator` and return it from createTranslator().
export interface Translator {
  /** Call from a user gesture: may trigger a one-time on-device language pack download. */
  prepare(src: string, tgt: string, onProgress?: (fraction: number) => void): Promise<void>;
  translate(text: string, src: string, tgt: string): Promise<string>;
}

declare const Translator: any; // not yet in TS lib.dom

class BuiltInTranslator implements Translator {
  private pairs = new Map<string, Promise<any>>();
  private get(src: string, tgt: string, onProgress?: (f: number) => void) {
    const key = `${src}>${tgt}`;
    if (!this.pairs.has(key)) {
      // create() is called synchronously so the caller's user activation is still valid
      // (a first-time language pack download requires it).
      const p: Promise<any> = Translator.create({
        sourceLanguage: src, targetLanguage: tgt,
        monitor: (m: EventTarget) => m.addEventListener('downloadprogress', (e: any) => onProgress?.(e.loaded)),
      }).catch((e: Error) => { throw new Error(`이 기기에서는 ${src}→${tgt} 온디바이스 번역을 사용할 수 없습니다. (${e.message})`); });
      p.catch(() => this.pairs.delete(key)); // allow retry
      this.pairs.set(key, p);
    }
    return this.pairs.get(key)!;
  }
  async prepare(src: string, tgt: string, onProgress?: (f: number) => void) { await this.get(src, tgt, onProgress); }
  async translate(text: string, src: string, tgt: string) { return (await this.get(src, tgt)).translate(text); }
}

/** null → no local translation engine in this browser. */
export const createTranslator = (): Translator | null => ('Translator' in self ? new BuiltInTranslator() : null);
