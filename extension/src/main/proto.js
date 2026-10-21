// Leitor mínimo de Protocol Buffers (wire format), sem dependências.
// Usado no "main world" das páginas de reunião e nos testes em Node.
(function (root) {
  "use strict";

  const WIRE_VARINT = 0;
  const WIRE_I64 = 1;
  const WIRE_LEN = 2;
  const WIRE_I32 = 5;

  const utf8 = new TextDecoder("utf-8", { fatal: true });

  function readVarint(buf, pos) {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error("varint truncado");
      const byte = buf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [result, pos];
      shift += 7n;
    }
    throw new Error("varint longo demais");
  }

  // Decodifica uma mensagem em uma lista de campos {no, wire, value}.
  // Para campos LEN, `value` é o Uint8Array bruto (pode ser string ou submensagem).
  function decode(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
      const [tag, next] = readVarint(buf, pos);
      pos = next;
      const no = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (no === 0) throw new Error("campo 0 inválido");
      if (wire === WIRE_VARINT) {
        const [v, p] = readVarint(buf, pos);
        fields.push({ no, wire, value: v });
        pos = p;
      } else if (wire === WIRE_LEN) {
        const [len, p] = readVarint(buf, pos);
        const end = p + Number(len);
        if (end > buf.length) throw new Error("campo LEN truncado");
        fields.push({ no, wire, value: buf.subarray(p, end) });
        pos = end;
      } else if (wire === WIRE_I64) {
        if (pos + 8 > buf.length) throw new Error("i64 truncado");
        fields.push({ no, wire, value: buf.subarray(pos, pos + 8) });
        pos += 8;
      } else if (wire === WIRE_I32) {
        if (pos + 4 > buf.length) throw new Error("i32 truncado");
        fields.push({ no, wire, value: buf.subarray(pos, pos + 4) });
        pos += 4;
      } else {
        throw new Error(`wire type ${wire} não suportado`);
      }
    }
    return fields;
  }

  function tryDecode(buf) {
    try {
      return decode(buf);
    } catch {
      return null;
    }
  }

  function field(fields, no) {
    return fields && fields.find((f) => f.no === no);
  }

  function str(fields, no) {
    const f = field(fields, no);
    if (!f || f.wire !== WIRE_LEN) return undefined;
    try {
      return utf8.decode(f.value);
    } catch {
      return undefined;
    }
  }

  function num(fields, no) {
    const f = field(fields, no);
    return f && f.wire === WIRE_VARINT ? Number(f.value) : undefined;
  }

  function msg(fields, no) {
    const f = field(fields, no);
    return f && f.wire === WIRE_LEN ? tryDecode(f.value) : null;
  }

  // Segue um caminho de números de campo por submensagens aninhadas.
  function path(fields, nos) {
    let cur = fields;
    for (const no of nos) {
      cur = msg(cur, no);
      if (!cur) return null;
    }
    return cur;
  }

  // Percorre a árvore inteira (busca em largura), chamando visit(fields) em cada submensagem.
  function walk(fields, visit, maxNodes = 4000) {
    const queue = [fields];
    let seen = 0;
    while (queue.length && seen < maxNodes) {
      const cur = queue.shift();
      seen++;
      visit(cur);
      for (const f of cur) {
        if (f.wire !== WIRE_LEN || f.value.length < 2) continue;
        const sub = tryDecode(f.value);
        if (sub && sub.length) queue.push(sub);
      }
    }
  }

  // --- Encoder mínimo (para testes e ACKs) ---
  function encVarint(n) {
    let v = BigInt(n);
    const out = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return out;
  }

  // spec: [[no, "varint"|"string"|"bytes"|"message", value], ...]
  function encode(spec) {
    const out = [];
    for (const [no, type, value] of spec) {
      if (value === undefined || value === null) continue;
      if (type === "varint") {
        out.push(...encVarint((BigInt(no) << 3n) | 0n), ...encVarint(value));
        continue;
      }
      let bytes;
      if (type === "string") bytes = new TextEncoder().encode(value);
      else if (type === "message") bytes = encode(value);
      else bytes = value;
      out.push(...encVarint((BigInt(no) << 3n) | 2n), ...encVarint(bytes.length), ...bytes);
    }
    return new Uint8Array(out);
  }

  root.EscribanoteProto = { decode, tryDecode, field, str, num, msg, path, walk, encode };
})(globalThis);
