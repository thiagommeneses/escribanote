import React from "react";
import { Img, staticFile } from "remotion";

// Espaço lógico da tela do app: 1600×1000 (as capturas têm 2× isso).
export const SCREEN_W = 1600;
export const SCREEN_H = 1000;

export type Camera = { x: number; y: number; z: number }; // ponto focal (coordenadas da tela) e zoom

// Moldura de navegador com a tela dentro. `camera` move/zooma o conteúdo; `tilt` inclina a janela em 3D.
export const Browser: React.FC<{
  camera: Camera;
  tilt?: { rx?: number; ry?: number; rz?: number };
  rise?: number; // deslocamento vertical da janela (px) — entrada de baixo
  scale?: number;
  url?: string;
  children: React.ReactNode;
}> = ({ camera, tilt = {}, rise = 0, scale = 1, url = "escribanote · Planejamento do Q4", children }) => {
  const frameW = 1560;
  const frameH = 1015;
  const bar = 40;
  const innerW = frameW;
  const innerH = frameH - bar;
  const fit = innerW / SCREEN_W; // escala base da tela dentro da moldura
  const z = camera.z * fit;
  // leva o ponto focal (camera.x, camera.y) ao centro da área interna
  const tx = innerW / 2 - camera.x * z;
  const ty = innerH / 2 - camera.y * z;
  return (
    <div
      style={{
        position: "absolute",
        left: (1920 - frameW) / 2,
        top: (1080 - frameH) / 2 + 8,
        width: frameW,
        height: frameH,
        transform: `perspective(2400px) translateY(${rise}px) rotateX(${tilt.rx ?? 0}deg) rotateY(${tilt.ry ?? 0}deg) rotateZ(${tilt.rz ?? 0}deg) scale(${scale})`,
        transformStyle: "preserve-3d",
        borderRadius: 18,
        background: "#f6f4ef",
        boxShadow: "0 60px 140px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)",
        overflow: "hidden",
      }}
    >
      <div style={{ height: bar, background: "#ece9e2", display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: "1px solid rgba(0,0,0,.08)" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, display: "inline-block" }} />
        ))}
        <div style={{ marginLeft: 20, flex: 1, height: 24, borderRadius: 7, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#777", fontFamily: '"Hanken Grotesk", sans-serif' }}>
          {url}
        </div>
        <Img src={staticFile("img/icon.png")} style={{ width: 18, height: 18, borderRadius: 5 }} />
      </div>
      <div style={{ position: "relative", width: innerW, height: innerH, overflow: "hidden", background: "#fff" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: SCREEN_W, height: SCREEN_H, transform: `translate(${tx}px, ${ty}px) scale(${z})`, transformOrigin: "0 0" }}>
          {children}
        </div>
      </div>
    </div>
  );
};

export const Screen: React.FC<{ src: string; opacity?: number }> = ({ src, opacity = 1 }) => (
  <Img src={staticFile(`capturas/${src}.png`)} style={{ position: "absolute", left: 0, top: 0, width: SCREEN_W, height: SCREEN_H, opacity }} />
);
