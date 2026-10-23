import React from "react";
import { useCurrentFrame } from "remotion";

// Quantos caracteres já foram "digitados" no quadro `frame`: ritmo humano, determinístico.
export const typedCount = (text: string, frame: number, start: number, cps = 15) => {
  let t = start;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const jitter = ((i * 7919) % 11) / 10 - 0.5; // -0.5 … +0.5, estável por posição
    let dur = (30 / cps) * (1 + jitter * 0.5);
    if (",.?!".includes(ch)) dur *= 2.2;
    if (ch === " ") dur *= 0.7;
    t += dur;
    if (frame >= t) n = i + 1;
    else break;
  }
  return n;
};

export const Typing: React.FC<{
  text: string;
  start: number; // quadro em que começa a digitar (relativo à sequência)
  cps?: number;
  style?: React.CSSProperties;
  caret?: boolean;
}> = ({ text, start, cps = 15, style, caret = true }) => {
  const frame = useCurrentFrame();
  const n = typedCount(text, frame, start, cps);
  const done = n >= text.length;
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <span style={{ whiteSpace: "pre", ...style }}>
      {text.slice(0, n)}
      {caret && (!done || blink) && frame >= start - 10 ? <span style={{ display: "inline-block", width: 2, height: "1.05em", background: "currentColor", verticalAlign: "-0.15em", marginLeft: 1, opacity: blink || !done ? 1 : 0 }} /> : null}
    </span>
  );
};
