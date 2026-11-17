// MediaStream(s) / media element → 16 kHz mono PCM frames, off the main thread (AudioWorklet).
export class AudioPipeline {
  private ctx!: AudioContext;
  private node!: AudioWorkletNode;
  private sources = new Map<string, AudioNode>();
  onFrame: (frame: Float32Array) => void = () => {};

  async init() {
    this.ctx = new AudioContext({ sampleRate: 16000 }); // browser resamples every input to 16 kHz
    await this.ctx.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI));
    this.node = new AudioWorkletNode(this.ctx, 'pcm', { channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 1 });
    this.node.port.onmessage = (e) => this.onFrame(e.data);
    const mute = this.ctx.createGain(); // keeps the graph pulling without playing captured audio back
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
  }

  /** Add or replace a named input. Multiple inputs (e.g. tab + mic) are mixed. */
  setStream(key: string, stream: MediaStream | null) {
    this.sources.get(key)?.disconnect();
    this.sources.delete(key);
    if (!stream) return;
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.node);
    this.sources.set(key, src);
  }

  /** File playback input: audible to the user and fed to the recognizer. */
  setElement(key: string, el: HTMLMediaElement) {
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.node);
    src.connect(this.ctx.destination);
    this.sources.set(key, src);
  }

  pause() { return this.ctx.suspend(); }
  resume() { return this.ctx.resume(); }
  async close() { await this.ctx?.close(); }
}
