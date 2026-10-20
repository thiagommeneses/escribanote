// Utilidades compartilhadas pelos coletores que rodam no "main world" da página.
// A comunicação com o content script (isolated world) é feita via CustomEvent
// com detail em JSON (strings atravessam os mundos sem problemas).
(function (root) {
  "use strict";

  const EVENT = "reunilo:evt";

  function emit(kind, payload) {
    if (typeof document === "undefined") return;
    document.dispatchEvent(
      new CustomEvent(EVENT, { detail: JSON.stringify({ kind, ...payload }) }),
    );
  }

  function isGzip(b) {
    return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
  }

  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Normaliza o payload de um RTCDataChannel para Uint8Array, descompactando gzip
  // (às vezes precedido por 3 bytes de cabeçalho, como observado no Meet).
  async function toBytes(data) {
    let b;
    if (data instanceof ArrayBuffer) b = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof Blob !== "undefined" && data instanceof Blob) b = new Uint8Array(await data.arrayBuffer());
    else if (typeof data === "string") return new TextEncoder().encode(data);
    else return null;
    if (isGzip(b)) return inflate(b, "gzip");
    if (isGzip(b.subarray(3))) return inflate(b.subarray(3), "gzip");
    return b;
  }

  // Envolve um handler para que exceções nunca quebrem a página da reunião.
  function safe(fn) {
    return function () {
      try {
        const r = fn.apply(this, arguments);
        if (r && typeof r.catch === "function") r.catch(() => {});
        return r;
      } catch {
        return undefined;
      }
    };
  }

  root.ReuniloCore = { EVENT, emit, toBytes, inflate, isGzip, safe };
})(globalThis);
