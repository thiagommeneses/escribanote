// AudioWorklet: converte a entrada para mono e envia blocos de ~100 ms para o documento.
class ReuniloCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.len = 0;
  }

  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length) return true;
    const n = chans[0].length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < chans.length; c++) v += chans[c][i];
      this.buf[this.len++] = v / chans.length;
      if (this.len === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(1600);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("reunilo-capture", ReuniloCapture);
