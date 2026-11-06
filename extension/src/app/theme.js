// Tema das páginas. Modo: "auto" segue o sistema; "light" e "dark" fixam pelo atributo data-theme do <html>.
// Variante (data-palette): no claro "default" ou "paper" (off-white e pastel); no escuro "default" ou "editor"
// (grafite, estilo VS Code / Cursor). No automático vale a variante do lado em uso, e ela troca junto com o sistema.
// Script clássico carregado no <head>: aplica o último tema guardado antes de pintar a página (sem piscar),
// depois confere com o ajuste salvo e acompanha as mudanças feitas em outra aba ou no painel lateral.
(() => {
  const KEY = "escribanote-theme";
  const root = document.documentElement;
  const mq = matchMedia("(prefers-color-scheme: dark)");
  let cur = { theme: "auto", themeLight: "default", themeDark: "default" };
  const apply = (t) => {
    cur = {
      theme: t?.theme === "light" || t?.theme === "dark" ? t.theme : "auto",
      themeLight: t?.themeLight === "paper" ? "paper" : "default",
      themeDark: t?.themeDark === "editor" ? "editor" : "default",
    };
    if (cur.theme === "auto") root.removeAttribute("data-theme");
    else root.dataset.theme = cur.theme;
    const dark = cur.theme === "dark" || (cur.theme === "auto" && mq.matches);
    const pal = dark ? (cur.themeDark === "editor" ? "editor" : "") : cur.themeLight === "paper" ? "paper" : "";
    if (pal) root.dataset.palette = pal;
    else root.removeAttribute("data-palette");
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch {}
  };
  // Guardado antigo era só o modo ("light"/"dark"/"auto").
  try {
    const raw = localStorage.getItem(KEY);
    apply(raw && raw.startsWith("{") ? JSON.parse(raw) : { theme: raw });
  } catch {}
  mq.addEventListener("change", () => apply(cur));
  if (!globalThis.chrome?.storage) return;
  chrome.storage.local.get("settings").then(({ settings }) => apply(settings || {})).catch(() => {});
  chrome.storage.onChanged.addListener((ch) => { if (ch.settings) apply(ch.settings.newValue || {}); });
})();
