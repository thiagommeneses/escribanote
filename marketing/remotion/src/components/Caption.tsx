import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C } from "../theme";

// Legenda de uma linha na base do quadro, dentro da área segura. Entra com mola, sai com fade.
export const Caption: React.FC<{ children: React.ReactNode; from?: number; out?: number }> = ({ children, from = 0, out }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - from, fps, config: { damping: 18, stiffness: 120 } });
  const o = out !== undefined ? interpolate(frame, [out, out + 10], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 62,
        textAlign: "center",
        fontFamily: C.sans,
        fontWeight: 600,
        fontSize: 34,
        letterSpacing: -0.2,
        color: C.ink,
        opacity: s * o,
        transform: `translateY(${(1 - s) * 30}px)`,
      }}
    >
      <span style={{ background: "rgba(0,0,0,.45)", padding: "10px 26px", borderRadius: 999, backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,.08)" }}>{children}</span>
    </div>
  );
};

export const Title: React.FC<{ children: React.ReactNode; size?: number; from?: number; out?: number; top?: number }> = ({ children, size = 96, from = 0, out, top = 120 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - from, fps, config: { damping: 16, stiffness: 100 } });
  const o = out !== undefined ? interpolate(frame, [out, out + 12], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, textAlign: "center", fontFamily: C.serif, fontWeight: 500, fontSize: size, lineHeight: 1.05, letterSpacing: -2, color: C.ink, opacity: s * o, transform: `translateY(${(1 - s) * 40}px)` }}>
      {children}
    </div>
  );
};
