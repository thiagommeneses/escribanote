import { normalize } from "../lib/transcript.js";
import { toHtml } from "../lib/format.js";
import { getSettings } from "../lib/settings.js";

const id = new URLSearchParams(location.search).get("id");
const doc = document.getElementById("doc");

(async () => {
  const raw = id ? await chrome.runtime.sendMessage({ type: "get", id }) : null;
  if (!raw || raw.error) {
    doc.textContent = "Reunião não encontrada.";
    return;
  }
  const session = normalize(raw);
  const [settings, shotUrls] = await Promise.all([getSettings(), chrome.runtime.sendMessage({ type: "get-shots", id })]);
  document.title = session.title;
  doc.innerHTML = toHtml(session, { tags: settings.tags, shotUrls: shotUrls || {} }) +
    `<p class="foot">Gerado pelo Escribanote em ${new Date().toLocaleString("pt-BR")}</p>`;
  document.getElementById("print").addEventListener("click", () => print());
  await Promise.all([...doc.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  setTimeout(() => print(), 300);
})();
