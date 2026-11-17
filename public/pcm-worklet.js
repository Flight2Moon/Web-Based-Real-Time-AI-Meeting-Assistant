// Runs on the audio thread: forwards mono PCM in 100 ms frames (1600 samples @ 16 kHz).
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm', PcmProcessor);
