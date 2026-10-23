import { normalize } from "../lib/transcript.js";
import { toHtml, mdToHtml } from "../lib/format.js";
import { getSettings } from "../lib/settings.js";

const params = new URLSearchParams(location.search);
const id = params.get("id");
const ONLY_ATA = params.get("ata") === "1";
const doc = document.getElementById("doc");

(async () => {
  const raw = id ? await chrome.runtime.sendMessage({ type: "get", id }) : null;
  if (!raw || raw.error) {
    doc.textContent = "Reunião não encontrada.";
    return;
  }
  const session = normalize(raw);
  const [settings, shotUrls] = await Promise.all([getSettings(), chrome.runtime.sendMessage({ type: "get-shots", id })]);
  document.title = ONLY_ATA ? `Ata — ${session.title}` : session.title;
  doc.innerHTML = (ONLY_ATA
    ? (session.summary?.text ? mdToHtml(session.summary.text) : "<p>Esta reunião ainda não tem ata.</p>")
    : toHtml(session, { tags: settings.tags, shotUrls: shotUrls || {} })) +
    `<p class="foot">Gerado pelo Escribanote em ${new Date().toLocaleString("pt-BR")}</p>`;
  document.getElementById("print").addEventListener("click", () => print());
  await Promise.all([...doc.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  setTimeout(() => print(), 300);
})();
