// Visualizador dos slides (extensão e app web): navegar, apresentar em tela cheia, editar o texto,
// trocar estilo/paleta/tema sem gastar crédito e baixar .pptx ou PDF. Usa só o DOM, sem dependências.
import { cleanDeck, deckMeta, deckPrintHtml, deckTheme, deckToPptx, deckFileName, slideHtml, shortClock, DECK_CSS, DECK_STYLES, DECK_PALETTES } from "./slides.js";

const LAYOUT_LABEL = { capa: "Capa", secao: "Seção", topicos: "Tópicos", acoes: "Ações", citacao: "Citação", imagem: "Imagem", numeros: "Números", encerramento: "Encerramento" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const VIEW_CSS = `
.esv{position:fixed;inset:0;z-index:2147483000;background:#0b1020;color:#e2e8f0;display:grid;grid-template-rows:auto 1fr;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}
.esv *{box-sizing:border-box}
.esv-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid #1e293b;background:#0f172a}
.esv-bar h2{font-size:15px;margin:0 8px 0 0;flex:1 1 200px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.esv .esv-btn,.esv-bar select{font:inherit;font-size:13px;color:#e2e8f0;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:6px 10px;cursor:pointer;width:auto;min-width:0;height:auto;margin:0;box-shadow:none}
.esv .esv-btn:hover{background:#273449}
.esv .esv-btn:disabled{opacity:.45;cursor:default}
.esv .esv-btn.pri{background:#2563eb;border-color:#2563eb;color:#fff}
.esv .esv-btn[aria-pressed="true"]{background:#334155;border-color:#64748b}
.esv-bar select{padding:5px 6px;flex:none}
.esv-body{display:grid;grid-template-columns:168px 1fr;min-height:0}
.esv.editing .esv-body{grid-template-columns:168px 1fr 320px}
.esv-thumbs{overflow:auto;padding:10px;border-right:1px solid #1e293b;display:flex;flex-direction:column;gap:10px}
.esv-thumb{position:relative;border:2px solid transparent;border-radius:6px;padding:0;background:none;cursor:pointer;display:block;width:100%}
.esv-thumb[aria-current="true"]{border-color:#60a5fa}
.esv-thumb .n{position:absolute;left:4px;top:3px;font-size:10px;background:#0f172acc;color:#e2e8f0;border-radius:4px;padding:0 4px}
.esv-thumb .esd-slide{pointer-events:none;border-radius:4px}
.esv-main{min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px;overflow:auto}
.esv-stage{width:min(100%,calc((100vh - 260px) * 16 / 9));margin:0 auto;box-shadow:0 10px 40px #0008;border-radius:6px;overflow:hidden;flex:none}
.esv-nav{display:flex;gap:8px;justify-content:center;align-items:center;color:#94a3b8}
.esv-notes{width:min(100%,calc((100vh - 260px) * 16 / 9));margin:0 auto;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;white-space:pre-wrap;color:#cbd5e1}
.esv-notes b{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px;font-weight:600}
.esv-edit{border-left:1px solid #1e293b;padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px;background:#0f172a}
.esv-edit label{display:grid;gap:4px;font-size:12px;color:#94a3b8}
.esv-edit input,.esv-edit textarea,.esv-edit select{margin:0;height:auto;box-shadow:none;font:inherit;font-size:13px;color:#e2e8f0;background:#0b1020;border:1px solid #334155;border-radius:6px;padding:6px 8px;width:100%}
.esv-edit textarea{resize:vertical;min-height:70px}
.esv-edit .row{display:flex;gap:6px;flex-wrap:wrap}
.esv-edit .hint{font-size:11px;color:#64748b}
.esv-status{font-size:12px;color:#94a3b8;min-width:70px}
.esv-present{position:fixed;inset:0;background:#000;display:flex;align-items:center;justify-content:center;z-index:2147483001;cursor:none}
.esv-present .esv-stage{width:min(100vw,calc(100vh * 16 / 9));box-shadow:none;border-radius:0}
.esv-present:hover{cursor:default}
.esv-present .esv-exit{font:inherit;font-size:13px;color:#e2e8f0;background:#1e293bcc;border:1px solid #334155;border-radius:8px;padding:6px 10px;cursor:pointer;position:fixed;right:12px;top:10px;opacity:0;transition:opacity .2s}
.esv-present:hover .esv-exit{opacity:1}
@media (max-width:760px){.esv-body,.esv.editing .esv-body{grid-template-columns:1fr}.esv-thumbs{display:none}.esv-edit{border-left:0;border-top:1px solid #1e293b}.esv-bar h2{flex-basis:100%}}
`;

function injectCss() {
  if (document.getElementById("esv-css")) return;
  const st = document.createElement("style");
  st.id = "esv-css";
  st.textContent = DECK_CSS + VIEW_CSS;
  document.head.appendChild(st);
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

// PDF pela impressão do navegador ("Salvar como PDF"), num iframe escondido com um slide por página.
export function printDeck(deck, session, shotUrls = {}) {
  const fr = document.createElement("iframe");
  fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  fr.srcdoc = deckPrintHtml(deck, session, shotUrls);
  fr.onload = () => {
    const imgs = [...fr.contentDocument.images];
    Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r))))).then(() => {
      fr.contentWindow.focus();
      fr.contentWindow.print();
      setTimeout(() => fr.remove(), 60_000);
    });
  };
  document.body.appendChild(fr);
}

export function downloadPptx(deck, session, shotUrls = {}) {
  download(deckFileName(session, "pptx"), deckToPptx(deck, session, shotUrls));
}

// Miniatura de um slide (lista e cartões). Devolve HTML.
export function deckThumbHtml(deck, session, shotUrls = {}, index = 0) {
  injectCss();
  const d = cleanDeck(deck);
  if (!d) return "";
  const metas = deckMeta(d, session, Object.keys(shotUrls));
  return slideHtml(d, d.slides[index], deckTheme(d), metas[index], shotUrls, { links: false });
}

// Abre o visualizador. onSave(deck) grava (edição e tema); onJump(msRelativo) leva à fala da reunião.
export function openDeck({ deck, session, shotUrls = {}, onSave, onJump, index = 0, present = false, editable = true, onRegenerate }) {
  injectCss();
  let d = cleanDeck(deck);
  if (!d) return null;
  let cur = Math.min(Math.max(0, index), d.slides.length - 1);
  let editing = false;
  let saveTimer = null;
  const root = document.createElement("div");
  root.className = "esv";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Slides da reunião");
  const prevFocus = document.activeElement;
  const opt = (list, val) => list.map((x) => `<option value="${x.id}" ${x.id === val ? "selected" : ""}>${esc(x.label)}</option>`).join("");

  function setStatus(t) { const el = root.querySelector(".esv-status"); if (el) el.textContent = t; }
  function save() {
    if (!onSave || !editable) return;
    clearTimeout(saveTimer);
    setStatus("Salvando…");
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try { await onSave(structuredClone(d)); setStatus("Salvo"); } catch (err) { setStatus("Não salvou"); console.warn(err); }
    }, 600);
  }

  function frame() {
    root.innerHTML = `
      <div class="esv-bar">
        <h2 title="${esc(d.title)}">${esc(d.title)}</h2>
        <select data-k="style" aria-label="Estilo" ${editable ? "" : "disabled"}>${opt(DECK_STYLES, d.style)}</select>
        <select data-k="palette" aria-label="Paleta de cores" ${editable ? "" : "disabled"}>${opt(DECK_PALETTES, d.palette)}</select>
        <select data-k="mode" aria-label="Tema" ${editable ? "" : "disabled"}><option value="claro" ${d.mode === "claro" ? "selected" : ""}>Claro</option><option value="escuro" ${d.mode === "escuro" ? "selected" : ""}>Escuro</option></select>
        <span class="esv-status" aria-live="polite"></span>
        ${editable ? `<button type="button" class="esv-btn" data-a="edit" aria-pressed="${editing}">Editar texto</button>` : ""}
        <button type="button" class="esv-btn" data-a="pptx" title="Abre no PowerPoint, no Keynote e no Google Slides, com as notas do apresentador">Baixar .pptx</button>
        <button type="button" class="esv-btn" data-a="pdf" title="Escolha &quot;Salvar como PDF&quot; na janela de impressão">PDF</button>
        ${onRegenerate ? `<button type="button" class="esv-btn" data-a="regen">Gerar de novo</button>` : ""}
        <button type="button" class="esv-btn pri" data-a="present">Apresentar</button>
        <button type="button" class="esv-btn" data-a="close" aria-label="Fechar">Fechar</button>
      </div>
      <div class="esv-body">
        <nav class="esv-thumbs" aria-label="Slides"></nav>
        <div class="esv-main">
          <div class="esv-stage"></div>
          <div class="esv-nav"><button type="button" class="esv-btn" data-a="prev" aria-label="Slide anterior">‹</button><span class="esv-pos"></span><button type="button" class="esv-btn" data-a="next" aria-label="Próximo slide">›</button></div>
          <div class="esv-notes"></div>
        </div>
        ${editing ? `<aside class="esv-edit" aria-label="Editar slide"></aside>` : ""}
      </div>`;
    root.classList.toggle("editing", editing);
    draw();
  }

  function draw() {
    const th = deckTheme(d);
    const metas = deckMeta(d, session, Object.keys(shotUrls));
    root.querySelector(".esv-thumbs").innerHTML = d.slides
      .map((s, i) => `<div role="button" tabindex="0" class="esv-thumb" data-i="${i}" aria-current="${i === cur}" aria-label="Slide ${i + 1}: ${esc(s.title || LAYOUT_LABEL[s.layout])}"><span class="n">${i + 1}</span>${slideHtml(d, s, th, metas[i], shotUrls, { links: false })}</div>`)
      .join("");
    root.querySelector(".esv-thumb[aria-current=true]")?.scrollIntoView({ block: "nearest" });
    const stageHtml = slideHtml(d, d.slides[cur], th, metas[cur], shotUrls);
    root.querySelector(".esv-main .esv-stage").innerHTML = stageHtml;
    const pres = document.querySelector(".esv-present .esv-stage");
    if (pres) pres.innerHTML = stageHtml;
    root.querySelector(".esv-pos").textContent = `${cur + 1} de ${d.slides.length}`;
    const s = d.slides[cur];
    const notes = root.querySelector(".esv-notes");
    notes.innerHTML = `<b>Notas do apresentador${metas[cur].at != null ? ` · ${shortClock(metas[cur].at)} na reunião` : ""}</b>${s.notes ? esc(s.notes) : '<span style="color:#64748b">Sem notas neste slide.</span>'}`;
    if (editing) drawEditor();
  }

  function drawEditor() {
    const s = d.slides[cur];
    const box = root.querySelector(".esv-edit");
    const field = (k, label, val, area = false, hint = "") => `<label>${label}${area ? `<textarea data-f="${k}" rows="${k === "notes" ? 6 : 5}">${esc(val)}</textarea>` : `<input data-f="${k}" value="${esc(val)}">`}${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
    let html = `<label>Layout<select data-f="layout">${Object.entries(LAYOUT_LABEL).map(([k, l]) => `<option value="${k}" ${k === s.layout ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
    if (s.layout === "capa") html += field("deckTitle", "Título da apresentação", s.title || d.title) + field("subtitle", "Subtítulo", d.subtitle);
    else if (s.layout === "citacao") html += field("quote", "Citação", s.quote, true) + field("speaker", "Quem disse", s.speaker);
    else html += field("title", "Título", s.title);
    if (s.layout === "numeros") html += field("stats", "Números", s.stats.map((x) => `${x.value} | ${x.label}`).join("\n"), true, "Um por linha: valor | rótulo (até 4).");
    else if (!["capa", "secao", "citacao"].includes(s.layout)) html += field("bullets", s.layout === "acoes" ? "Ações" : "Tópicos", s.bullets.join("\n"), true, "Um por linha.");
    html += field("notes", "Notas do apresentador", s.notes, true);
    html += `<div class="row"><button type="button" class="esv-btn" data-a="up" ${cur === 0 ? "disabled" : ""}>Subir</button><button type="button" class="esv-btn" data-a="down" ${cur === d.slides.length - 1 ? "disabled" : ""}>Descer</button><button type="button" class="esv-btn" data-a="dup">Duplicar</button><button type="button" class="esv-btn" data-a="del" ${d.slides.length < 2 ? "disabled" : ""}>Apagar slide</button></div>`;
    box.innerHTML = html;
  }

  function applyField(k, v) {
    const s = d.slides[cur];
    if (k === "deckTitle") { s.title = v; d.title = v; root.querySelector(".esv-bar h2").textContent = v; }
    else if (k === "subtitle") d.subtitle = v;
    else if (k === "bullets") s.bullets = v.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
    else if (k === "stats") s.stats = v.split("\n").map((x) => x.split("|")).map(([a, ...b]) => ({ value: (a || "").trim().slice(0, 24), label: b.join("|").trim().slice(0, 70) })).filter((x) => x.value).slice(0, 4);
    else if (k === "layout") s.layout = v;
    else s[k] = v;
  }

  const go = (i) => { cur = Math.min(Math.max(0, i), d.slides.length - 1); draw(); };

  function presentMode() {
    const p = document.createElement("div");
    p.className = "esv-present";
    p.innerHTML = `<div class="esv-stage"></div><button type="button" class="esv-exit" data-a="exit">Sair (Esc)</button>`;
    p.addEventListener("click", (e) => {
      if (e.target.closest("[data-a=exit]")) return exitPresent();
      const at = e.target.closest(".esd-at");
      if (at) return;
      go(cur + (e.clientX < innerWidth / 3 ? -1 : 1));
    });
    document.body.appendChild(p);
    draw();
    p.requestFullscreen?.().catch(() => {});
    const onFs = () => { if (!document.fullscreenElement && p.isConnected) exitPresent(); };
    p._onFs = onFs;
    document.addEventListener("fullscreenchange", onFs);
  }
  function exitPresent() {
    const p = document.querySelector(".esv-present");
    if (!p) return;
    document.removeEventListener("fullscreenchange", p._onFs);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    p.remove();
  }
  function close() {
    exitPresent();
    if (saveTimer && onSave && editable) { clearTimeout(saveTimer); saveTimer = null; onSave(structuredClone(d)).catch(() => {}); }
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    prevFocus?.focus?.();
  }

  function onKey(e) {
    if (e.target.closest?.("input, textarea, select")) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Enter" && e.target.closest?.(".esv-thumb")) { e.preventDefault(); return go(Number(e.target.closest(".esv-thumb").dataset.i)); }
    if (["ArrowRight", "PageDown", " ", "ArrowDown"].includes(e.key)) { e.preventDefault(); go(cur + 1); }
    else if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key)) { e.preventDefault(); go(cur - 1); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(d.slides.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); if (document.querySelector(".esv-present")) exitPresent(); else close(); }
    else if (e.key.toLowerCase() === "f" || e.key === "F5") { e.preventDefault(); if (!document.querySelector(".esv-present")) presentMode(); }
  }

  root.addEventListener("click", (e) => {
    const at = e.target.closest(".esd-at");
    if (at && onJump) { close(); onJump(Number(at.dataset.at)); return; }
    const th = e.target.closest(".esv-thumb");
    if (th) return go(Number(th.dataset.i));
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "close") close();
    else if (a === "prev") go(cur - 1);
    else if (a === "next") go(cur + 1);
    else if (a === "present") presentMode();
    else if (a === "edit") { editing = !editing; frame(); }
    else if (a === "pptx") downloadPptx(d, session, shotUrls);
    else if (a === "pdf") printDeck(d, session, shotUrls);
    else if (a === "regen") { close(); onRegenerate(); }
    else if (a === "up" && cur > 0) { [d.slides[cur - 1], d.slides[cur]] = [d.slides[cur], d.slides[cur - 1]]; cur--; draw(); save(); }
    else if (a === "down" && cur < d.slides.length - 1) { [d.slides[cur + 1], d.slides[cur]] = [d.slides[cur], d.slides[cur + 1]]; cur++; draw(); save(); }
    else if (a === "dup") { d.slides.splice(cur + 1, 0, { ...structuredClone(d.slides[cur]), id: Math.random().toString(36).slice(2, 9) }); cur++; draw(); save(); }
    else if (a === "del" && d.slides.length > 1) { d.slides.splice(cur, 1); cur = Math.min(cur, d.slides.length - 1); draw(); save(); }
  });
  root.addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (k) { d[k] = e.target.value; draw(); save(); return; }
    if (e.target.dataset.f === "layout") { applyField("layout", e.target.value); draw(); save(); }
  });
  root.addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    if (!f || f === "layout") return;
    applyField(f, e.target.value);
    const th = deckTheme(d);
    const metas = deckMeta(d, session, Object.keys(shotUrls));
    root.querySelector(".esv-main .esv-stage").innerHTML = slideHtml(d, d.slides[cur], th, metas[cur], shotUrls);
    const thumb = root.querySelector(`.esv-thumb[data-i="${cur}"]`);
    if (thumb) thumb.innerHTML = `<span class="n">${cur + 1}</span>${slideHtml(d, d.slides[cur], th, metas[cur], shotUrls, { links: false })}`;
    if (f === "notes") root.querySelector(".esv-notes").lastChild.textContent = e.target.value;
    save();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(root);
  frame();
  root.querySelector("[data-a=present]").focus();
  if (present) presentMode();
  return { close, root };
}
