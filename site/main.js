// Demonstração do widget no topo: as falas entram uma a uma, a legenda errada é
// corrigida pelo reconhecimento e a decisão recebe o marca-texto.
(() => {
  "use strict";
  const body = document.getElementById("demo-body");
  const time = document.getElementById("demo-time");
  const share = document.getElementById("demo-share");
  if (!body) return;

  const people = {
    ana: { name: "Ana", color: "oklch(78% 0.12 40)", tile: "t1" },
    bruno: { name: "Bruno", color: "oklch(78% 0.1 200)", tile: "t2" },
    carla: { name: "Carla", color: "oklch(80% 0.12 130)", tile: "t3" },
    voce: { name: "Você", color: "oklch(78% 0.1 290)", tile: "t4" },
  };
  // [quem, segundos, html, efeito]
  const script = [
    ["ana", 4, "Bom dia! Vamos direto ao orçamento do <span class='fix'><span class='bad'>quiu quatro</span></span>?", { fix: "Q4" }],
    ["bruno", 11, "A proposta de mídia ficou em 180 mil, dá pra fechar até <span class='fix'><span class='bad'>sesta</span></span>.", { fix: "sexta" }],
    ["voce", 19, "Fechado então: aprovamos os 180 mil para o Q4.", { tag: "✅ Decisão", hl: true }],
    ["carla", 26, "Eu atualizo o <span class='fix'><span class='bad'>ó que erre</span></span> do time de vendas hoje.", { fix: "OKR", tag: "📌 Ação" }],
    ["ana", 33, "Perfeito. Próximo ponto: contratação.", {}],
  ];

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const talk = { voce: 0, total: 0 };

  function speak(i) {
    const [who, sec, html, fx] = script[i];
    const p = people[who];
    document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("speaking", t.classList.contains(p.tile)));
    const li = document.createElement("li");
    li.innerHTML = `<div class="who" style="color:${p.color}">${p.name}<time>${mmss(sec)}</time>${fx.tag ? `<span class="tag">${fx.tag}</span>` : ""}</div><p>${fx.hl ? `<span class="hl">${html}</span>` : html}</p>`;
    body.append(li);
    while (body.children.length > 5) body.firstElementChild.remove();
    time.textContent = mmss(sec);
    const words = html.replace(/<[^>]+>/g, "").split(/\s+/).length;
    talk.total += words;
    if (who === "voce") talk.voce += words;
    share.textContent = Math.round((talk.voce / talk.total) * 100) + "%";

    const fix = li.querySelector(".fix");
    if (fix && fx.fix) {
      const apply = () => {
        fix.querySelector(".bad").style.opacity = "0.45";
        fix.insertAdjacentHTML("beforeend", ` <span class="good">${fx.fix}</span>`);
      };
      reduce ? apply() : setTimeout(apply, 1100);
    }
    if (fx.hl) {
      const hl = li.querySelector(".hl");
      reduce ? hl.classList.add("on") : setTimeout(() => hl.classList.add("on"), 900);
    }
  }

  if (reduce) {
    script.forEach((_, i) => speak(i));
    return;
  }
  let i = 0;
  const loop = () => {
    if (i === 0) {
      body.innerHTML = "";
      talk.voce = 0;
      talk.total = 0;
    }
    speak(i);
    i = (i + 1) % script.length;
    setTimeout(loop, i === 0 ? 5200 : 2600);
  };
  // Só anima enquanto o widget está visível.
  let started = false;
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !started) {
      started = true;
      setTimeout(loop, 700);
    }
  }).observe(body);

  // Versão disponível para download (manifesto publicado junto do zip).
  fetch("download/latest.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return;
      document.getElementById("dl-version").textContent = "v" + j.version;
      document.getElementById("download").href = "download/" + j.file;
    })
    .catch(() => {});
})();

// Formulário de contato. Antes de enviar, o navegador resolve uma prova de trabalho (achar o número
// cujo SHA-256 bate com o desafio do servidor): leva ~1 s para uma pessoa e encarece o envio em massa.
// O desafio é pedido e resolvido assim que a pessoa começa a preencher, para o envio sair na hora.
(() => {
  "use strict";
  const form = document.getElementById("contact-form");
  if (!form) return;
  const status = form.querySelector(".contact-status");
  const button = form.querySelector("button");
  let prova = null;

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function resolver() {
    const r = await fetch("/api/contato/desafio", { cache: "no-store" });
    if (!r.ok) throw new Error("desafio");
    const d = await r.json();
    // O servidor recusa envios a menos de 3 s do desafio; quem preenche rápido só espera um pouco.
    const pronto = performance.now() + 3300;
    for (let n = 0; n <= d.max; n++) {
      if ((await sha256Hex(d.salt + n)) === d.desafio) {
        await new Promise((ok) => setTimeout(ok, Math.max(0, pronto - performance.now())));
        return { ...d, numero: n };
      }
    }
    throw new Error("prova");
  }
  const preparar = () => (prova ||= resolver().catch((e) => { prova = null; throw e; }));
  form.addEventListener("focusin", preparar, { once: true });

  const say = (msg, kind = "") => { status.textContent = msg; status.dataset.kind = kind; };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    const bad = [...form.querySelectorAll("input[required], textarea[required]")].find((el) => !el.checkValidity());
    if (bad) {
      bad.setAttribute("aria-invalid", "true");
      bad.focus();
      return say(bad.name === "email" ? "Confira o seu e-mail." : bad.name === "nome" ? "Informe seu nome." : "Escreva a mensagem (pelo menos 10 caracteres).", "erro");
    }
    button.disabled = true;
    say("Enviando…");
    try {
      const f = new FormData(form);
      const body = { nome: f.get("nome"), email: f.get("email"), mensagem: f.get("mensagem"), site: f.get("site"), prova: await preparar() };
      const r = await fetch("/api/contato", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok || !j.campo) { prova = null; preparar().catch(() => {}); } // prova gasta: já resolve a próxima
      if (!r.ok) {
        const campo = j.campo && form.elements[j.campo];
        if (campo) { campo.setAttribute("aria-invalid", "true"); campo.focus(); }
        const m = j.erro || "não foi possível enviar";
        return say(m.charAt(0).toUpperCase() + m.slice(1) + ".", "erro");
      }
      form.reset();
      say("Mensagem enviada. Obrigado! A resposta vai para o e-mail que você informou.", "ok");
    } catch {
      prova = null;
      say("Não foi possível enviar agora. Tente de novo em instantes.", "erro");
    } finally {
      button.disabled = false;
    }
  });
})();
