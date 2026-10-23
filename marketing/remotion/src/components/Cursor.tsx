import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

export type CursorKey = { f: number; x: number; y: number; click?: boolean };

// Cursor vetorial (seta) que percorre pontos-chave com easing e faz uma onda no clique.
// Coordenadas no espaço da tela (1600×1000). `frame` relativo à sequência.
export const Cursor: React.FC<{ keys: CursorKey[]; scale?: number }> = ({ keys, scale = 1 }) => {
  const frame = useCurrentFrame();
  if (!keys.length) return null;
  const fs = keys.map((k) => k.f);
  const xs = keys.map((k) => k.x);
  const ys = keys.map((k) => k.y);
  const opts = { easing: Easing.bezier(0.22, 1, 0.36, 1), extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const x = keys.length > 1 ? interpolate(frame, fs, xs, opts) : xs[0];
  const y = keys.length > 1 ? interpolate(frame, fs, ys, opts) : ys[0];
  const visible = frame >= fs[0] - 6;
  const clicks = keys.filter((k) => k.click);
  const pressed = clicks.some((k) => frame >= k.f && frame < k.f + 6);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, opacity: visible ? 1 : 0, pointerEvents: "none" }}>
      {clicks.map((k) => {
        const p = interpolate(frame, [k.f, k.f + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        if (p <= 0 || p >= 1) return null;
        return (
          <div key={k.f} style={{ position: "absolute", left: k.x - 28, top: k.y - 28, width: 56, height: 56, borderRadius: 28, border: "3px solid #d9583a", opacity: 1 - p, transform: `scale(${0.3 + p * 1.2})` }} />
        );
      })}
      <svg viewBox="0 0 24 24" width={28 * scale} height={28 * scale} style={{ position: "absolute", left: x - 3, top: y - 2, transform: `scale(${pressed ? 0.85 : 1})`, transformOrigin: "3px 2px", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))" }}>
        <path d="M5.5 3.2 18.2 13.6l-6.1.6 3.3 6.8-2.6 1.2-3.2-6.9-4.1 4.6z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
