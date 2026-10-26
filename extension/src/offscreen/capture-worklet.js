// AudioWorklet: converte a entrada para mono e envia blocos de ~100 ms para o documento.
class EscribanoteCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.len = 0;
  }

  process(inputs) {
    const chans = inputs[0];
    // Sem fonte ligada (microfone trocado, faixa encerrada), o tempo continua passando: entra
    // silêncio no lugar, para os horários das falas seguintes não adiantarem.
    const n = chans && chans.length ? chans[0].length : 128;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (chans && chans.length) {
        for (let c = 0; c < chans.length; c++) v += chans[c][i];
        v /= chans.length;
      }
      this.buf[this.len++] = v;
      if (this.len === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(1600);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("escribanote-capture", EscribanoteCapture);
