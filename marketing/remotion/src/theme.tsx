import { continueRender, delayRender, staticFile } from "remotion";
import { useEffect, useState } from "react";

export const C = {
  bg: "#1a1410",
  bg2: "#2a1f18",
  ink: "#f3ead8",
  ink2: "#cdbfa6",
  ink3: "#9a8b73",
  accent: "#d9583a",
  marker: "#f0c53a",
  serif: '"Fraunces", Georgia, serif',
  sans: '"Hanken Grotesk", "Segoe UI", system-ui, sans-serif',
};

const css = `
@font-face { font-family: "Fraunces"; font-style: italic; font-weight: 300 800; src: url(${staticFile("fonts/fraunces-italic-latin.woff2")}) format("woff2"); }
@font-face { font-family: "Fraunces"; font-style: normal; font-weight: 300 800; src: url(${staticFile("fonts/fraunces-normal-latin.woff2")}) format("woff2"); }
@font-face { font-family: "Hanken Grotesk"; font-style: normal; font-weight: 100 900; src: url(${staticFile("fonts/hanken-normal-latin.woff2")}) format("woff2"); }
`;

// Carrega as fontes do site antes de renderizar qualquer quadro.
export const Fonts = () => {
  const [handle] = useState(() => delayRender("fontes"));
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
    Promise.all([
      document.fonts.load('italic 500 40px "Fraunces"'),
      document.fonts.load('normal 500 40px "Fraunces"'),
      document.fonts.load('normal 700 40px "Hanken Grotesk"'),
    ]).then(() => continueRender(handle)).catch(() => continueRender(handle));
  }, [handle]);
  return null;
};
