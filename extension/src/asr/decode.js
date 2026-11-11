// Leitura em fluxo de arquivos de áudio e vídeo para o Whisper: wav, mp3, ogg (Opus/Vorbis), webm/mkv
// (Opus/Vorbis) e mp4/m4a/mov (AAC/MP3). O arquivo é lido aos poucos (janelas de 8 MB) e entregue em
// trechos de ~30 s já em mono 16 kHz, então um áudio de 3 h nunca é decodificado inteiro na memória.
// Os formatos comprimidos passam pelo decodificador nativo do navegador (WebCodecs); o que não der
// para ler assim (formato raro, mp4 fragmentado) cai na decodificação inteira, só para arquivos menores.
export const OUT_RATE = 16000;
const WINDOW = 8 * 1024 * 1024;
const CHUNK_OUT = OUT_RATE * 30; // trechos entregues: 30 s
export const WHOLE_MAX_BYTES = 300 * 1024 * 1024; // acima disto, sem leitura em fluxo, recusa

// ---------- leitura do arquivo em janelas ----------
class Source {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.wStart = 0;
    this.win = new Uint8Array(0);
    this.maxPos = 0; // até onde já se leu (progresso por bytes)
  }
  async bytes(off, len) {
    if (off >= this.wStart && off + len <= this.wStart + this.win.length) return this.win.subarray(off - this.wStart, off - this.wStart + len);
    const end = Math.min(this.size, off + Math.max(len, WINDOW));
    this.win = new Uint8Array(await this.file.slice(off, end).arrayBuffer());
    this.wStart = off;
    this.maxPos = Math.max(this.maxPos, end);
    return this.win.subarray(0, Math.min(len, this.win.length));
  }
}
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

// ---------- reamostragem em fluxo (sinc com janela, qualquer razão) ----------
export class Resampler {
  constructor(inRate, outRate = OUT_RATE, half = 16) {
    this.r = inRate / outRate;
    this.same = inRate === outRate;
    this.half = half;
    const cut = Math.min(1, 1 / this.r) * 0.92;
    const PH = 256;
    this.ph = PH;
    this.table = new Float32Array((PH + 1) * 2 * half);
    for (let p = 0; p <= PH; p++) {
      const frac = p / PH;
      let sum = 0;
      for (let j = -half + 1; j <= half; j++) {
        const t = frac - j;
        const x = Math.PI * cut * t;
        const sinc = t === 0 ? 1 : Math.sin(x) / x;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half); // Blackman
        const v = Math.abs(t) >= half ? 0 : cut * sinc * w;
        this.table[p * 2 * half + (j + half - 1)] = v;
        sum += v;
      }
      for (let j = 0; j < 2 * half; j++) this.table[p * 2 * half + j] /= sum || 1;
    }
    this.buf = new Float32Array(0);
    this.bufStart = 0; // índice global da amostra buf[0]
    this.next = 0; // próxima amostra de saída
  }
  push(x) {
    if (this.same) return x;
    const merged = new Float32Array(this.buf.length + x.length);
    merged.set(this.buf);
    merged.set(x, this.buf.length);
    this.buf = merged;
    const out = new Float32Array(Math.ceil(x.length / this.r) + 2);
    let n = 0;
    const { half, ph, table, r } = this;
    const end = this.bufStart + this.buf.length;
    for (;;) {
      const p = this.next * r;
      const c = Math.floor(p);
      if (c + half >= end) break;
      const t = Math.round((p - c) * ph) * 2 * half;
      let s = 0;
      for (let j = -half + 1; j <= half; j++) {
        const k = c + j - this.bufStart;
        if (k >= 0) s += this.buf[k] * table[t + j + half - 1];
      }
      if (n >= out.length) break;
      out[n++] = s;
      this.next++;
    }
    const keepFrom = Math.max(0, Math.floor(this.next * r) - half - this.bufStart);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.bufStart += keepFrom;
    }
    return out.subarray(0, n);
  }
  flush() {
    return this.same ? new Float32Array(0) : this.push(new Float32Array(this.half * 2 + Math.ceil(this.r)));
  }
}

function mixAudioData(ad) {
  const n = ad.numberOfFrames;
  const ch = ad.numberOfChannels;
  const out = new Float32Array(n);
  const tmp = ch > 1 ? new Float32Array(n) : out;
  for (let c = 0; c < ch; c++) {
    ad.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
    if (ch > 1) for (let i = 0; i < n; i++) out[i] += tmp[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}
function mixBuffer(ab) {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= ab.numberOfChannels;
  return out;
}

// Junta saídas pequenas em trechos de ~30 s (a última sai no flush).
class Gatherer {
  constructor() { this.parts = []; this.n = 0; }
  add(x) { if (x.length) { this.parts.push(x); this.n += x.length; } }
  take(force = false) {
    if (!this.n || (!force && this.n < CHUNK_OUT)) return null;
    const out = new Float32Array(this.n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    this.parts = [];
    this.n = 0;
    return out;
  }
}

// Pacotes comprimidos -> decodificador nativo -> mono 16 kHz.
async function* viaDecoder(config, packets) {
  const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) throw new Unsupported(`o navegador não decodifica ${config.codec}`);
  const outs = [];
  let failure = null;
  const dec = new AudioDecoder({ output: (ad) => { try { outs.push({ rate: ad.sampleRate, data: mixAudioData(ad) }); } finally { ad.close(); } }, error: (e) => (failure = e) });
  dec.configure(config);
  let rs = null;
  const g = new Gatherer();
  const drain = () => {
    for (const o of outs.splice(0)) {
      if (!rs || rs.inRate !== o.rate) { if (rs) g.add(rs.flush()); rs = new Resampler(o.rate); rs.inRate = o.rate; }
      g.add(rs.push(o.data));
    }
  };
  // Sem flush() no meio: ele reinicia o decodificador, e o MP3 (reservatório de bits) perde quadros a cada
  // reinício. A fila do decodificador fica limitada esperando o evento "dequeue".
  const dequeued = () => new Promise((r) => { dec.addEventListener("dequeue", r, { once: true }); setTimeout(r, 50); });
  let ts = 0;
  try {
    for await (const data of packets) {
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: ts, data }));
      ts += 20_000;
      while (dec.decodeQueueSize > 64 && !failure) await dequeued();
      if (failure) throw failure;
      drain();
      let c;
      while ((c = g.take())) yield c;
    }
    await dec.flush();
    if (failure) throw failure;
    drain();
    if (rs) g.add(rs.flush());
    const last = g.take(true);
    if (last) yield last;
  } finally {
    if (dec.state !== "closed") dec.close();
  }
}

export class Unsupported extends Error {}

// ---------- WAV ----------
async function wavInfo(src) {
  const h = await src.bytes(0, 12);
  if (ascii(h, 0, 4) !== "RIFF" && ascii(h, 0, 4) !== "RF64") return null;
  if (ascii(h, 8, 4) !== "WAVE") return null;
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= src.size && !data) {
    const c = await src.bytes(pos, 8);
    const id = ascii(c, 0, 4);
    let size = u32le(c, 4);
    if (id === "fmt ") {
      const f = await src.bytes(pos + 8, Math.min(size, 40));
      let format = u16le(f, 0);
      if (format === 0xfffe && size >= 26) format = u16le(f, 24);
      fmt = { format, channels: u16le(f, 2), rate: u32le(f, 4), bits: u16le(f, 14) };
    } else if (id === "data") {
      if (size === 0 || size === 0xffffffff || pos + 8 + size > src.size) size = src.size - pos - 8;
      data = { offset: pos + 8, size };
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) return null;
  if (!((fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32))) throw new Unsupported("WAV com codificação não suportada");
  const frame = (fmt.bits / 8) * fmt.channels;
  return { ...fmt, ...data, frame, durationMs: Math.round(((data.size / frame) / fmt.rate) * 1000) };
}
async function* wavStream(src, w) {
  const rs = new Resampler(w.rate);
  const g = new Gatherer();
  const block = w.frame * w.rate * 10;
  const bps = w.bits / 8;
  for (let off = 0; off < w.size; off += block) {
    const b = await src.bytes(w.offset + off, Math.min(block, w.size - off));
    const frames = Math.floor(b.length / w.frame);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < w.channels; c++) {
        const p = i * w.frame + c * bps;
        s += w.format === 3 ? dv.getFloat32(p, true) : bps === 1 ? (b[p] - 128) / 128 : bps === 2 ? dv.getInt16(p, true) / 32768 : bps === 3 ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) << 8 >> 8) / 8388608 : dv.getInt32(p, true) / 2147483648;
      }
      mono[i] = s / w.channels;
    }
    g.add(rs.push(mono));
    let c;
    while ((c = g.take())) yield c;
  }
  g.add(rs.flush());
  const last = g.take(true);
  if (last) yield last;
}

// ---------- MP3 ----------
const MP3_BR = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Header(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
  const rate = MP3_SR[ver][sri];
  const kbps = MP3_BR[ver === 3 ? 1 : 2][bri];
  const spf = ver === 3 ? 1152 : 576;
  const len = Math.floor(((spf / 8) * kbps * 1000) / rate) + pad;
  const channels = (b[i + 3] >> 6) === 3 ? 1 : 2;
  return { rate, kbps, spf, len, channels, ver };
}
async function mp3Info(src) {
  let pos = 0;
  const h = await src.bytes(0, 10);
  if (ascii(h, 0, 3) === "ID3") pos = 10 + ((h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9]) + (h[5] & 0x10 ? 10 : 0);
  const b = await src.bytes(pos, 64 * 1024);
  for (let i = 0; i + 4 < b.length; i++) {
    const f = mp3Header(b, i);
    if (!f) continue;
    const next = mp3Header(b, i + f.len);
    if (!next && i + f.len + 4 < b.length) continue; // sincronização falsa
    // Xing/Info (VBR): número de quadros dá a duração exata
    const side = f.ver === 3 ? (f.channels === 1 ? 17 : 32) : f.channels === 1 ? 9 : 17;
    const x = i + 4 + side;
    let frames = null;
    if (["Xing", "Info"].includes(ascii(b, x, 4)) && b[x + 7] & 1) frames = u32be(b, x + 8);
    const durationMs = frames ? Math.round((frames * f.spf * 1000) / f.rate) : Math.round(((src.size - pos - i) * 8) / f.kbps);
    return { start: pos + i, ...f, durationMs };
  }
  return null;
}
async function* mp3Packets(src, m) {
  let pos = m.start;
  while (pos + 4 <= src.size) {
    let b = await src.bytes(pos, 4);
    const f = mp3Header(b, 0);
    if (!f) { pos++; continue; } // ressincroniza (lixo ou tag no meio)
    if (pos + f.len > src.size) break;
    b = await src.bytes(pos, f.len);
    yield b.slice();
    pos += f.len;
  }
}

// ---------- OGG ----------
async function* oggPackets(src, wantSerial) {
  let pos = 0, partial = [];
  while (pos + 27 <= src.size) {
    const h = await src.bytes(pos, 27);
    if (ascii(h, 0, 4) !== "OggS") { pos++; continue; }
    const serial = u32le(h, 14);
    const nseg = h[26];
    const lace = (await src.bytes(pos + 27, nseg)).slice();
    let bodyLen = 0;
    for (const l of lace) bodyLen += l;
    const body = (await src.bytes(pos + 27 + nseg, bodyLen)).slice();
    pos += 27 + nseg + bodyLen;
    if (wantSerial != null && serial !== wantSerial) continue;
    if (!(h[5] & 1)) partial = []; // página que não continua um pacote anterior
    let o = 0;
    for (const l of lace) {
      partial.push(body.subarray(o, o + l));
      o += l;
      if (l < 255) {
        const len = partial.reduce((s, p) => s + p.length, 0);
        const pkt = new Uint8Array(len);
        let q = 0;
        for (const p of partial) { pkt.set(p, q); q += p.length; }
        partial = [];
        yield { serial, data: pkt, granule: h.subarray(6, 14) };
      }
    }
  }
}
function xiphLace(packets) {
  const head = [packets.length - 1];
  for (const p of packets.slice(0, -1)) {
    let n = p.length;
    while (n >= 255) { head.push(255); n -= 255; }
    head.push(n);
  }
  const out = new Uint8Array(head.length + packets.reduce((s, p) => s + p.length, 0));
  out.set(head);
  let o = head.length;
  for (const p of packets) { out.set(p, o); o += p.length; }
  return out;
}
async function oggInfo(src) {
  const h = await src.bytes(0, 4);
  if (ascii(h, 0, 4) !== "OggS") return null;
  let serial = null, kind = null, headers = [];
  for await (const p of oggPackets(src)) {
    if (serial == null) {
      if (ascii(p.data, 0, 8) === "OpusHead") (serial = p.serial), (kind = "opus");
      else if (p.data[0] === 1 && ascii(p.data, 1, 6) === "vorbis") (serial = p.serial), (kind = "vorbis");
      else continue;
    }
    if (p.serial !== serial) continue;
    headers.push(p.data);
    if ((kind === "opus" && headers.length === 2) || (kind === "vorbis" && headers.length === 3)) break;
  }
  if (!kind) throw new Unsupported("OGG sem áudio Opus ou Vorbis");
  const id = headers[0];
  const channels = kind === "opus" ? id[9] : id[11];
  const rate = kind === "opus" ? 48000 : u32le(id, 12);
  const preskip = kind === "opus" ? u16le(id, 10) : 0;
  // duração: posição (granule) da última página deste fluxo
  let durationMs = null;
  const tailLen = Math.min(src.size, 256 * 1024);
  const tail = (await src.bytes(src.size - tailLen, tailLen)).slice();
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] === 0x4f && ascii(tail, i, 4) === "OggS" && u32le(tail, i + 14) === serial) {
      const lo = u32le(tail, i + 6), hi = u32le(tail, i + 10);
      const granule = hi * 4294967296 + lo;
      if (granule > 0 && hi < 0x7fffffff) durationMs = Math.round(((granule - preskip) / rate) * 1000);
      break;
    }
  }
  const config = { codec: kind, sampleRate: rate, numberOfChannels: channels, description: kind === "opus" ? headers[0] : xiphLace(headers) };
  return { serial, kind, config, headerCount: headers.length, durationMs };
}
async function* oggAudio(src, o) {
  let skipped = 0;
  for await (const p of oggPackets(src, o.serial)) {
    if (skipped < o.headerCount) { skipped++; continue; }
    yield p.data;
  }
}

// ---------- WebM / Matroska ----------
const EBML = { Segment: 0x18538067, Cluster: 0x1f43b675, BlockGroup: 0xa0, Tracks: 0x1654ae6b, TrackEntry: 0xae, Audio: 0xe1, Info: 0x1549a966, SimpleBlock: 0xa3, Block: 0xa1, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Sampling: 0xb5, Channels: 0x9f, Duration: 0x4489, TimecodeScale: 0x2ad7b1, Header: 0x1a45dfa3 };
const MASTERS = new Set([EBML.Segment, EBML.Cluster, EBML.BlockGroup, EBML.Tracks, EBML.TrackEntry, EBML.Audio, EBML.Info]);
function vint(b, i, keepMarker) {
  const first = b[i];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let v = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let k = 1; k < len; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xff) allOnes = false; }
  return { v, len, unknown: !keepMarker && allOnes };
}
function readFloat(b) { const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return b.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }
function readUint(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
// Percorre os elementos de forma "achatada" (entra nos contêineres sem depender do tamanho deles, que
// no WebM gravado ao vivo costuma ser desconhecido) e chama visit(id, dados) nos que interessam.
async function* ebmlWalk(src, wanted) {
  let pos = 0;
  while (pos + 2 <= src.size) {
    const hb = await src.bytes(pos, 12);
    if (hb.length < 2) return;
    const id = vint(hb, 0, true);
    if (!id) return;
    const size = vint(hb, id.len, false);
    if (!size) return;
    const dataStart = pos + id.len + size.len;
    if (MASTERS.has(id.v)) { if (id.v === EBML.TrackEntry) yield { id: id.v }; pos = dataStart; continue; }
    if (size.unknown) return;
    if (wanted.has(id.v)) yield { id: id.v, data: (await src.bytes(dataStart, size.v)).slice() };
    pos = dataStart + size.v;
  }
}
async function webmInfo(src) {
  const h = await src.bytes(0, 4);
  if (u32be(h, 0) !== EBML.Header) return null;
  const tracks = [];
  let scale = 1_000_000, duration = null;
  const want = new Set([EBML.TrackNumber, EBML.TrackType, EBML.CodecID, EBML.CodecPrivate, EBML.Sampling, EBML.Channels, EBML.Duration, EBML.TimecodeScale, EBML.SimpleBlock, EBML.Block]);
  for await (const e of ebmlWalk(src, want)) {
    if (e.id === EBML.SimpleBlock || e.id === EBML.Block) break; // as faixas vêm antes dos blocos
    if (e.id === EBML.TrackEntry) { tracks.push({}); continue; }
    const t = tracks.at(-1);
    if (e.id === EBML.TimecodeScale) scale = readUint(e.data);
    else if (e.id === EBML.Duration) duration = readFloat(e.data);
    else if (!t) continue;
    else if (e.id === EBML.TrackNumber) t.number = readUint(e.data);
    else if (e.id === EBML.TrackType) t.type = readUint(e.data);
    else if (e.id === EBML.CodecID) t.codec = ascii(e.data, 0, e.data.length).replace(/\0+$/, "");
    else if (e.id === EBML.CodecPrivate) t.priv = e.data;
    else if (e.id === EBML.Sampling) t.rate = readFloat(e.data);
    else if (e.id === EBML.Channels) t.channels = readUint(e.data);
  }
  const a = tracks.find((t) => t.codec === "A_OPUS" || t.codec === "A_VORBIS");
  if (!a) throw new Unsupported("WebM/MKV sem áudio Opus ou Vorbis");
  const opus = a.codec === "A_OPUS";
  const config = { codec: opus ? "opus" : "vorbis", sampleRate: opus ? 48000 : Math.round(a.rate || 48000), numberOfChannels: a.channels || (opus && a.priv ? a.priv[9] : 2), ...(a.priv ? { description: a.priv } : {}) };
  return { track: a.number, config, durationMs: duration ? Math.round((duration * scale) / 1e6) : null };
}
async function* webmAudio(src, w) {
  for await (const e of ebmlWalk(src, new Set([EBML.SimpleBlock, EBML.Block]))) {
    if (!e.data) continue;
    const tn = vint(e.data, 0, false);
    if (!tn || tn.v !== w.track) continue;
    const flags = e.data[tn.len + 2];
    const body = e.data.subarray(tn.len + 3);
    const lacing = (flags >> 1) & 3;
    if (!lacing) { yield body; continue; }
    const n = body[0] + 1;
    let o = 1;
    const sizes = [];
    if (lacing === 1) {
      for (let k = 0; k < n - 1; k++) { let s = 0, x; do { x = body[o++]; s += x; } while (x === 255); sizes.push(s); }
    } else if (lacing === 3) {
      let first = vint(body, o, false); o += first.len; sizes.push(first.v);
      for (let k = 1; k < n - 1; k++) { const d = vint(body, o, false); o += d.len; const bias = 2 ** (7 * d.len - 1) - 1; sizes.push(sizes[k - 1] + d.v - bias); }
    } else {
      const each = (body.length - 1) / n;
      for (let k = 0; k < n - 1; k++) sizes.push(each);
    }
    sizes.push(body.length - o - sizes.reduce((s, x) => s + x, 0));
    for (const s of sizes) { yield body.subarray(o, o + s); o += s; }
  }
}

// ---------- MP4 / M4A / MOV ----------
async function boxes(src, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const h = await src.bytes(pos, 16);
    let size = u32be(h, 0);
    const type = ascii(h, 4, 4);
    let head = 8;
    if (size === 1) { size = u32be(h, 8) * 4294967296 + u32be(h, 12); head = 16; }
    else if (size === 0) size = end - pos;
    if (size < head) break;
    out.push({ type, start: pos, head, size, end: pos + size });
    pos += size;
  }
  return out;
}
function childBoxes(b, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    let head = 8;
    if (size === 1) { size = u32be(b, pos + 8) * 4294967296 + u32be(b, pos + 12); head = 16; }
    else if (size === 0) size = end - pos;
    if (size < head) break;
    out.push({ type, start: pos, head, end: Math.min(end, pos + size) });
    pos += size;
  }
  return out;
}
const find = (b, start, end, path) => {
  let cur = [{ start: start - 8, head: 8, end }];
  for (const t of path) {
    const next = [];
    for (const box of cur) next.push(...childBoxes(b, box.start + box.head, box.end).filter((x) => x.type === t));
    cur = next;
  }
  return cur;
};
function esdsConfig(b, s) {
  // descritores MPEG-4: ES_Descriptor (3) > DecoderConfigDescriptor (4) > DecoderSpecificInfo (5)
  let i = s.start + s.head + 4;
  const desc = () => { const tag = b[i++]; let len = 0, x; do { x = b[i++]; len = (len << 7) | (x & 0x7f); } while (x & 0x80); return { tag, len }; };
  let d = desc();
  if (d.tag === 3) { const flags = b[i + 2]; i += 3; if (flags & 0x80) i += 2; if (flags & 0x40) i += 1 + b[i]; if (flags & 0x20) i += 2; d = desc(); }
  if (d.tag !== 4) return null;
  const oti = b[i];
  i += 13;
  const ds = desc();
  const asc = ds.tag === 5 ? b.slice(i, i + ds.len) : null;
  return { oti, asc };
}
async function mp4Info(src) {
  const h = await src.bytes(0, 12);
  if (!["ftyp", "moov", "wide", "mdat", "free", "skip", "pnot"].includes(ascii(h, 4, 4))) return null;
  const top = await boxes(src, 0, src.size);
  const moov = top.find((x) => x.type === "moov");
  if (!moov) throw new Unsupported("MP4 sem índice (moov)");
  if (moov.size > 256 * 1024 * 1024) throw new Unsupported("índice do MP4 grande demais");
  const b = (await src.bytes(moov.start, moov.size)).slice();
  const len = b.length;
  for (const trak of find(b, 8, len, ["trak"])) {
    const hdlr = find(b, trak.start + trak.head, trak.end, ["mdia", "hdlr"])[0];
    if (!hdlr || ascii(b, hdlr.start + hdlr.head + 8, 4) !== "soun") continue;
    const mdhd = find(b, trak.start + trak.head, trak.end, ["mdia", "mdhd"])[0];
    const v = b[mdhd.start + mdhd.head];
    const timescale = v === 1 ? u32be(b, mdhd.start + mdhd.head + 20) : u32be(b, mdhd.start + mdhd.head + 12);
    const dur = v === 1 ? u32be(b, mdhd.start + mdhd.head + 24) * 4294967296 + u32be(b, mdhd.start + mdhd.head + 28) : u32be(b, mdhd.start + mdhd.head + 16);
    const stbl = find(b, trak.start + trak.head, trak.end, ["mdia", "minf", "stbl"])[0];
    const stsd = childBoxes(b, stbl.start + stbl.head, stbl.end).find((x) => x.type === "stsd");
    const entry = childBoxes(b, stsd.start + stsd.head + 8, stsd.end)[0];
    if (!entry) continue;
    const e0 = entry.start + 8;
    const ver = u16be(b, e0 + 8);
    const channels = u16be(b, e0 + 16);
    const rate = u16be(b, e0 + 24);
    const kids = e0 + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    let config = null;
    if (entry.type === "mp4a") {
      const esds = childBoxes(b, kids, entry.end).find((x) => x.type === "esds") || find(b, kids, entry.end, ["wave", "esds"])[0];
      const ec = esds && esdsConfig(b, esds);
      if (ec && [0x40, 0x66, 0x67, 0x68].includes(ec.oti) && ec.asc) {
        let aot = ec.asc[0] >> 3;
        if (aot === 31) aot = 32 + (((ec.asc[0] & 7) << 3) | (ec.asc[1] >> 5));
        config = { codec: `mp4a.40.${aot}`, sampleRate: rate || 44100, numberOfChannels: channels || 2, description: ec.asc };
      } else if (ec && [0x69, 0x6b].includes(ec.oti)) config = { codec: "mp3", sampleRate: rate || 44100, numberOfChannels: channels || 2 };
    } else if (entry.type === ".mp3") config = { codec: "mp3", sampleRate: rate || 44100, numberOfChannels: channels || 2 };
    if (!config) throw new Unsupported(`áudio ${entry.type} dentro do MP4/MOV`);
    const kidsOf = (t) => childBoxes(b, stbl.start + stbl.head, stbl.end).find((x) => x.type === t);
    const stsz = kidsOf("stsz"), stsc = kidsOf("stsc"), stco = kidsOf("stco") || kidsOf("co64");
    if (!stsz || !stsc || !stco || !u32be(b, stsz.start + stsz.head + 8)) throw new Unsupported("MP4 fragmentado");
    const fixed = u32be(b, stsz.start + stsz.head + 4);
    const count = u32be(b, stsz.start + stsz.head + 8);
    const sizes = fixed ? null : new Uint32Array(count);
    if (sizes) for (let k = 0; k < count; k++) sizes[k] = u32be(b, stsz.start + stsz.head + 12 + k * 4);
    const nChunks = u32be(b, stco.start + stco.head + 4);
    const big = stco.type === "co64";
    const offsets = new Float64Array(nChunks);
    for (let k = 0; k < nChunks; k++) offsets[k] = big ? u32be(b, stco.start + stco.head + 8 + k * 8) * 4294967296 + u32be(b, stco.start + stco.head + 12 + k * 8) : u32be(b, stco.start + stco.head + 8 + k * 4);
    const nRuns = u32be(b, stsc.start + stsc.head + 4);
    const runs = [];
    for (let k = 0; k < nRuns; k++) runs.push({ first: u32be(b, stsc.start + stsc.head + 8 + k * 12), per: u32be(b, stsc.start + stsc.head + 12 + k * 12) });
    return { config, count, fixed, sizes, offsets, runs, durationMs: timescale ? Math.round((dur / timescale) * 1000) : null };
  }
  throw new Unsupported("MP4/MOV sem faixa de áudio");
}
async function* mp4Audio(src, m) {
  let sample = 0, run = 0;
  for (let c = 0; c < m.offsets.length && sample < m.count; c++) {
    while (run + 1 < m.runs.length && m.runs[run + 1].first <= c + 1) run++;
    let off = m.offsets[c];
    for (let k = 0; k < m.runs[run].per && sample < m.count; k++, sample++) {
      const size = m.fixed || m.sizes[sample];
      yield (await src.bytes(off, size)).slice();
      off += size;
    }
  }
}

// ---------- entrada ----------
// Descobre formato e duração sem decodificar. durationMs pode ser null (WebM gravado ao vivo).
export async function probeAudio(file) {
  const src = new Source(file);
  const tries = [["wav", wavInfo], ["ogg", oggInfo], ["webm", webmInfo], ["mp4", mp4Info], ["mp3", mp3Info]];
  let lastErr = null;
  for (const [format, fn] of tries) {
    try {
      const info = await fn(src);
      if (info) return { format, info, durationMs: info.durationMs ?? null, streaming: true };
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err;
      lastErr = err;
    }
  }
  return { format: "outro", info: null, durationMs: null, streaming: false, reason: lastErr?.message || "formato não reconhecido" };
}

// Gera trechos mono 16 kHz (~30 s cada). onBytes(lidos, total) informa o avanço pela posição no arquivo.
export async function* decodeAudio(file, { probe, onBytes } = {}) {
  const p = probe || (await probeAudio(file));
  const src = new Source(file);
  const report = () => onBytes?.(Math.min(src.maxPos, src.size), src.size);
  let gen;
  if (p.format === "wav") gen = wavStream(src, p.info);
  else if (p.format === "mp3") gen = viaDecoder({ codec: "mp3", sampleRate: p.info.rate, numberOfChannels: p.info.channels }, mp3Packets(src, p.info));
  else if (p.format === "ogg") gen = viaDecoder(p.info.config, oggAudio(src, p.info));
  else if (p.format === "webm") gen = viaDecoder(p.info.config, webmAudio(src, p.info));
  else if (p.format === "mp4") gen = viaDecoder(p.info.config, mp4Audio(src, p.info));
  if (gen) {
    let produced = false;
    try {
      for await (const c of gen) { produced = true; report(); yield c; }
      return;
    } catch (err) {
      // decodificador nativo sem suporte a este codec: tenta a decodificação inteira (se couber)
      if (produced || !(err instanceof Unsupported)) throw err;
    }
  }
  if (file.size > WHOLE_MAX_BYTES) throw new Error(`Não dá para ler este arquivo em partes (${p.reason || "formato não suportado"}) e ele é grande demais para ler de uma vez. Converta para m4a, mp3, ogg ou wav.`);
  const ctx = new OfflineAudioContext(1, 1, OUT_RATE);
  const ab = await ctx.decodeAudioData(await file.arrayBuffer());
  const mono = mixBuffer(ab);
  for (let o = 0; o < mono.length; o += CHUNK_OUT) yield mono.slice(o, o + CHUNK_OUT);
  onBytes?.(file.size, file.size);
}
