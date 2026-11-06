import { normalize } from "../lib/transcript.js";
import { toHtml, mdToHtml, fileName, ataFileName, dateLabel } from "../lib/format.js";
import { getSettings } from "../lib/settings.js";

const params = new URLSearchParams(location.search);
const id = params.get("id");
const ONLY_ATA = params.get("ata") === "1";
// Conversa da aba IA: what = "a" (só a resposta i), "qa" (pergunta e resposta i) ou "all" (a conversa inteira).
const CHAT = params.get("chat");
const strip = (t) => String(t || "").replace(/<reuniao_anterior[^>]*>[\s\S]*?<\/reuniao_anterior>/g, "").trim();
function chatHtml(session, chat, what, i) {
  if (!chat) return "<p>Conversa não encontrada.</p>";
  const head = `<h1>${what === "a" ? "Resposta da IA" : "Pergunta à IA"}</h1><p class="foot">${(session.title || "Reunião").replace(/</g, "&lt;")} · ${dateLabel(session.startedAt)}</p>`;
  if (what === "a") return head + mdToHtml(chat.messages[i]?.text || "");
  const pairs = [];
  chat.messages.forEach((m, k) => {
    if (m.role === "user") pairs.push({ q: strip(m.text), k: -1, a: "" });
    else if (pairs.length) Object.assign(pairs.at(-1), { a: m.text, k });
  });
  const pick = pairs.filter((p) => p.a && (what === "all" || p.k === i));
  return head + pick.map((p) => `<h2>Pergunta</h2>${mdToHtml(p.q)}<h2>Resposta</h2>${mdToHtml(p.a)}`).join("<hr>");
}
const doc = document.getElementById("doc");

(async () => {
  const raw = id ? await chrome.runtime.sendMessage({ type: "get", id }) : null;
  if (!raw || raw.error) {
    doc.textContent = "Reunião não encontrada.";
    return;
  }
  const session = normalize(raw);
  const [settings, shotUrls] = await Promise.all([getSettings(), chrome.runtime.sendMessage({ type: "get-shots", id })]);
  // O "Salvar como PDF" do Chrome usa o título da página como nome do arquivo.
  if (CHAT) {
    document.title = fileName(session, "pdf").replace(/\.pdf$/, "") + " - IA";
    doc.innerHTML = chatHtml(session, session.chats.find((c) => c.id === CHAT), params.get("what") || "all", Number(params.get("i")));
    document.getElementById("print").addEventListener("click", () => print());
    setTimeout(() => print(), 300);
    return;
  }
  document.title = (ONLY_ATA ? ataFileName(session, "pdf") : fileName(session, "pdf")).replace(/\.pdf$/, "");
  // "Incluir a ata e os textos institucionais" (desligado por padrão): sem ela, só a reunião, sem a ata e sem o rodapé.
  // O PDF "só a ata" (aba Ata) é pedido explícito e não muda.
  const institutional = ONLY_ATA || (settings.exportAta === true && settings.usage === "institutional");
  doc.innerHTML = (ONLY_ATA
    ? (session.summary?.text ? mdToHtml(session.summary.text) : "<p>Esta reunião ainda não tem ata.</p>")
    : toHtml(session, { tags: settings.tags, shotUrls: shotUrls || {}, ata: institutional, clean: settings.cleanSpeech === true, include: settings.exportInclude || undefined })) +
    (institutional ? `<p class="foot">Gerado pelo Escribanote em ${new Date().toLocaleString("pt-BR")}</p>` : "");
  document.getElementById("print").addEventListener("click", () => print());
  await Promise.all([...doc.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  setTimeout(() => print(), 300);
})();
