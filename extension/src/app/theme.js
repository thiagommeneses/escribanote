// Tema das páginas: "auto" segue o sistema; "light" e "dark" fixam pelo atributo data-theme do <html>.
// Script clássico carregado no <head>: aplica o último tema guardado antes de pintar a página (sem piscar),
// depois confere com o ajuste salvo e acompanha as mudanças feitas em outra aba ou no painel lateral.
(() => {
  const KEY = "escribanote-theme";
  const apply = (t) => {
    const theme = t === "light" || t === "dark" ? t : "auto";
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch {}
  };
  try { apply(localStorage.getItem(KEY)); } catch {}
  if (!globalThis.chrome?.storage) return;
  chrome.storage.local.get("settings").then(({ settings }) => apply(settings?.theme)).catch(() => {});
  chrome.storage.onChanged.addListener((ch) => { if (ch.settings) apply(ch.settings.newValue?.theme); });
})();
