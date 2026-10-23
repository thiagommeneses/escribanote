// Diff "inteligente" de textos (atas): alinha por linhas e, dentro das linhas que mudaram, compara
// por palavras. Sem dependências; usado pela extensão, pelo app web e pelo servidor.

// Quebra em tokens: palavras (com acentos), números, pontuação e espaços — nada se perde na remontagem.
export function tokenize(text) {
  return (text || "").match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || [];
}

// Myers O(ND) sobre arrays de strings. Retorna ops: {op: "eq"|"del"|"add", a: [i0,i1), b: [j0,j1)}.
export function diffArrays(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (!max) return [];
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x = k === -d || (k !== d && v[idx - 1] < v[idx + 1]) ? v[idx + 1] : v[idx - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) { x++; y++; }
      v[idx] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // reconstrói o caminho de trás para frente
  const path = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const idx = k + max;
    const prevK = k === -d || (k !== d && vd[idx - 1] < vd[idx + 1]) ? k + 1 : k - 1;
    const prevX = vd[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { path.push(["eq", --x, --y]); }
    if (d > 0) path.push(x === prevX ? ["add", x, --y] : ["del", --x, y]);
  }
  path.reverse();
  // agrupa em blocos
  const ops = [];
  for (const [op, i, j] of path) {
    const last = ops[ops.length - 1];
    if (last && last.op === op && last.a[1] === (op === "add" ? i : i) && last.b[1] === (op === "del" ? j : j)) {
      if (op !== "add") last.a[1] = i + 1;
      if (op !== "del") last.b[1] = j + 1;
    } else ops.push({ op, a: [i, op === "add" ? i : i + 1], b: [j, op === "del" ? j : j + 1] });
  }
  return ops;
}

// Diff por palavras de dois trechos. Retorna [{op, text}].
export function diffWords(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const ops = diffArrays(ta, tb);
  const out = [];
  for (const o of ops) {
    const text = o.op === "add" ? tb.slice(o.b[0], o.b[1]).join("") : ta.slice(o.a[0], o.a[1]).join("");
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += text;
    else out.push({ op: o.op, text });
  }
  return out;
}

// Diff de documentos: linhas iguais passam direto; blocos de linhas trocadas viram diff por palavras.
// Retorna [{kind: "same"|"changed"|"added"|"removed", a: string, b: string, words?: [{op,text}]}] por linha/bloco.
export function diffDocument(a, b) {
  const la = (a || "").replace(/\r/g, "").split("\n");
  const lb = (b || "").replace(/\r/g, "").split("\n");
  const norm = (s) => s.trim().replace(/\s+/g, " ");
  const ops = diffArrays(la, lb, (x, y) => norm(x) === norm(y));
  const blocks = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === "eq") {
      for (let k = o.a[0]; k < o.a[1]; k++) blocks.push({ kind: "same", a: la[k], b: lb[o.b[0] + (k - o.a[0])] });
      continue;
    }
    // del seguido de add = linhas substituídas: compara por palavras, pareando por posição
    const next = ops[i + 1];
    if (o.op === "del" && next && next.op === "add") {
      const dels = la.slice(o.a[0], o.a[1]);
      const adds = lb.slice(next.b[0], next.b[1]);
      const n = Math.max(dels.length, adds.length);
      // Poucas linhas de cada lado: junta tudo num bloco só e compara por palavras (parágrafos reescritos).
      if (dels.length <= 3 && adds.length <= 3) {
        const A = dels.join("\n");
        const B = adds.join("\n");
        blocks.push({ kind: "changed", a: A, b: B, words: diffWords(A, B) });
      } else {
        for (let k = 0; k < n; k++) {
          const A = dels[k];
          const B = adds[k];
          if (A !== undefined && B !== undefined) blocks.push({ kind: "changed", a: A, b: B, words: diffWords(A, B) });
          else if (A !== undefined) blocks.push({ kind: "removed", a: A, b: "" });
          else blocks.push({ kind: "added", a: "", b: B });
        }
      }
      i++;
      continue;
    }
    if (o.op === "del") for (let k = o.a[0]; k < o.a[1]; k++) blocks.push({ kind: "removed", a: la[k], b: "" });
    else for (let k = o.b[0]; k < o.b[1]; k++) blocks.push({ kind: "added", a: "", b: lb[k] });
  }
  return blocks;
}

// Contagem de palavras adicionadas/removidas (ignora espaços e pontuação).
export function diffStats(blocks) {
  let added = 0;
  let removed = 0;
  let changedLines = 0;
  const isWord = (t) => /[\p{L}\p{N}]/u.test(t);
  for (const b of blocks) {
    if (b.kind === "same") continue;
    changedLines++;
    if (b.kind === "added") added += tokenize(b.b).filter(isWord).length;
    else if (b.kind === "removed") removed += tokenize(b.a).filter(isWord).length;
    else for (const w of b.words) {
      const n = tokenize(w.text).filter(isWord).length;
      if (w.op === "add") added += n;
      else if (w.op === "del") removed += n;
    }
  }
  return { added, removed, changedLines };
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mdLite = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^(#{1,6})\s+/, "");

// HTML do comparador: inline (uma coluna, com remoções e adições marcadas) ou lado a lado.
// `onlyChanges` esconde linhas iguais, deixando 1 linha de contexto.
export function diffHtml(blocks, { mode = "inline", onlyChanges = false } = {}) {
  const rows = [];
  const keep = new Set();
  if (onlyChanges) blocks.forEach((b, i) => { if (b.kind !== "same") { keep.add(i - 1); keep.add(i); keep.add(i + 1); } });
  let gap = false;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (onlyChanges && !keep.has(i)) { gap = true; continue; }
    if (gap) { rows.push(`<div class="dgap">⋯</div>`); gap = false; }
    const words = (side) => b.words
      .filter((w) => w.op === "eq" || (side === "a" ? w.op === "del" : w.op === "add"))
      .map((w) => (w.op === "eq" ? mdLite(w.text) : `<${w.op === "del" ? "del" : "ins"}>${mdLite(w.text)}</${w.op === "del" ? "del" : "ins"}>`)).join("");
    if (mode === "side") {
      const left = b.kind === "same" ? mdLite(b.a) : b.kind === "added" ? "" : b.kind === "removed" ? `<del>${mdLite(b.a)}</del>` : words("a");
      const right = b.kind === "same" ? mdLite(b.b) : b.kind === "removed" ? "" : b.kind === "added" ? `<ins>${mdLite(b.b)}</ins>` : words("b");
      rows.push(`<div class="drow ${b.kind}"><div class="dcell">${left || "&nbsp;"}</div><div class="dcell">${right || "&nbsp;"}</div></div>`);
    } else {
      let inner;
      if (b.kind === "same") inner = mdLite(b.a) || "&nbsp;";
      else if (b.kind === "added") inner = `<ins>${mdLite(b.b)}</ins>`;
      else if (b.kind === "removed") inner = `<del>${mdLite(b.a)}</del>`;
      else inner = b.words.map((w) => (w.op === "eq" ? mdLite(w.text) : `<${w.op === "del" ? "del" : "ins"}>${mdLite(w.text)}</${w.op === "del" ? "del" : "ins"}>`)).join("");
      rows.push(`<div class="drow ${b.kind}">${inner}</div>`);
    }
  }
  return rows.join("") || '<div class="drow same">Sem diferenças.</div>';
}

// ---------- histórico de versões da ata (como um git simples, linear) ----------
export const MAX_VERSIONS = 40;

// Registra `summary` como nova versão, se o texto mudou. Retorna a versão criada ou null.
export function commitSummary(session, summary, { label, source = "ai", parentId } = {}) {
  session.summaryHistory ||= [];
  const text = (summary?.text || "").trim();
  if (!text) return null;
  const last = session.summaryHistory[session.summaryHistory.length - 1];
  if (last && last.text.trim() === text) return null;
  const v = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    n: (last?.n || 0) + 1,
    text,
    createdAt: summary?.createdAt || Date.now(),
    source, // "ai" | "edit" | "restore" | "sync"
    label: label || (source === "ai" ? "Gerada pela IA" : source === "edit" ? "Editada à mão" : "Restaurada"),
    model: summary?.model || null,
    templateId: summary?.templateId ?? null,
    parentId: parentId || last?.id || null,
  };
  session.summaryHistory.push(v);
  if (session.summaryHistory.length > MAX_VERSIONS) session.summaryHistory.splice(0, session.summaryHistory.length - MAX_VERSIONS);
  return v;
}

// Rótulo automático para uma versão gerada: diz o modelo usado e o tamanho da mudança.
export function describeVersion(session, v) {
  const prev = session.summaryHistory?.find((x) => x.id === v.parentId);
  if (!prev) return `${v.label} · primeira versão`;
  const st = diffStats(diffDocument(prev.text, v.text));
  if (!st.added && !st.removed) return `${v.label} · sem mudanças no texto`;
  return `${v.label} · +${st.added} −${st.removed} palavras`;
}
