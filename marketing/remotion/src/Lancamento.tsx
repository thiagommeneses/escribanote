import React from "react";
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Browser, Screen, SCREEN_W, SCREEN_H, Camera } from "./components/Browser";
import { Cursor } from "./components/Cursor";
import { Typing, typedCount } from "./components/Typing";
import { Caption, Title } from "./components/Caption";
import { C, Fonts } from "./theme";

export const FPS = 30;
// cenas (quadros): gancho 0–90 · lista 90–200 · transcrição 200–320 · renomear 320–480 · IA 480–620 · ata/análise 620–700 · Meet 700–760 · fecho 760–810
const S = { hook: 0, lista: 90, trans: 200, ren: 320, ia: 480, ata: 620, meet: 700, fim: 760 };
export const DURATION = 810;

// elementos do app (espaço da tela 1600×1000), medidos em capturas.mjs
const R = {
  card: { x: 175, y: 250 },
  speakers: { x: 510, y: 270, w: 920, h: 26 },
  nomePaula: { x: 609, y: 453 },
  askInput: { x: 571, y: 524, w: 258, h: 37 },
  askOk: { x: 796, y: 585 },
  tabIa: { x: 856, y: 192 },
  chatLog: { x: 525, y: 732, w: 890, h: 192 },
  ata: { x: 510, y: 336, w: 920, h: 338 },
  bars: { x: 510, y: 331, w: 920, h: 285 },
};

const ease = Easing.bezier(0.22, 1, 0.36, 1);
const lerp = (frame: number, from: number, to: number, a: number, b: number) => interpolate(frame, [from, to], [a, b], { easing: ease, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
const cam = (frame: number, from: number, to: number, a: Camera, b: Camera): Camera => ({ x: lerp(frame, from, to, a.x, b.x), y: lerp(frame, from, to, a.y, b.y), z: lerp(frame, from, to, a.z, b.z) });
const FULL: Camera = { x: SCREEN_W / 2, y: SCREEN_H / 2, z: 1 };

const Fade: React.FC<{ children: React.ReactNode; inF?: number; outAt?: number }> = ({ children, inF = 6, outAt }) => {
  const f = useCurrentFrame();
  const o = Math.min(interpolate(f, [0, inF], [0, 1], { extrapolateRight: "clamp" }), outAt !== undefined ? interpolate(f, [outAt, outAt + 8], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1);
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

// ---------- 1 · gancho ----------
const Gancho = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - 30, fps, config: { damping: 16, stiffness: 70, mass: 1.1 } });
  return (
    <>
      <Title size={88} top={44} out={44}>Cada palavra da reunião, <em style={{ fontStyle: "italic", color: C.marker }}>anotada.</em></Title>
      <Browser camera={FULL} rise={(1 - s) * 760} tilt={{ rx: 22 - 18 * s }} scale={0.84 + 0.04 * s} >
        <Screen src="02-transcricao" />
      </Browser>
    </>
  );
};

// ---------- 2 · lista de reuniões ----------
const Lista = () => {
  const f = useCurrentFrame();
  const c = cam(f, 0, 40, { x: 800, y: 500, z: 1 }, { x: 420, y: 380, z: 1.55 });
  return (
    <>
      <Browser camera={c} scale={0.88}>
        <Screen src="01-lista" />
        <Cursor keys={[{ f: 0, x: 900, y: 650 }, { f: 42, x: R.card.x + 40, y: R.card.y + 4, click: true }, { f: 110, x: R.card.x + 40, y: R.card.y + 4 }]} />
      </Browser>
      <Caption from={14}>Suas reuniões, do Meet ao Slack, num só lugar.</Caption>
    </>
  );
};

// ---------- 3 · transcrição com nomes (ângulo 3/4) ----------
const Transcricao = () => {
  const f = useCurrentFrame();
  const c = cam(f, 0, 110, { x: 960, y: 400, z: 1.55 }, { x: 960, y: 560, z: 1.75 });
  const ry = lerp(f, 0, 50, -2, -16);
  const glow = 0.35 + 0.25 * Math.sin(f / 5);
  return (
    <>
      <Browser camera={c} tilt={{ ry, rx: 3 }} scale={0.9}>
        <Screen src="02-transcricao" />
        <div style={{ position: "absolute", left: R.speakers.x - 8, top: R.speakers.y - 6, width: R.speakers.w + 16, height: R.speakers.h + 12, borderRadius: 10, boxShadow: `0 0 0 3px rgba(217,88,58,${glow})`, opacity: lerp(f, 20, 40, 0, 1) }} />
      </Browser>
      <Caption from={10}>Quem disse o quê, ao vivo.</Caption>
    </>
  );
};

// ---------- 4 · renomear (cursor + digitação) ----------
const Renomear = () => {
  const f = useCurrentFrame();
  const c = cam(f, 0, 30, { x: 760, y: 470, z: 1.6 }, { x: 700, y: 520, z: 2.15 });
  const editorOpen = f >= 46 && f < 136;
  const text = "Paula Franco (PM)";
  return (
    <>
      <Browser camera={c} scale={0.9}>
        <Screen src={editorOpen ? "03-renomear" : "02-transcricao"} />
        {editorOpen && (
          <div style={{ position: "absolute", left: R.askInput.x + 2, top: R.askInput.y + 2, width: R.askInput.w - 4, height: R.askInput.h - 4, background: "#fff", borderRadius: 6, padding: "0 9px", display: "flex", alignItems: "center", fontFamily: C.sans, fontSize: 15, color: "#1b1e24" }}>
            <Typing text={text} start={58} cps={16} />
          </div>
        )}
        <Cursor keys={[{ f: 0, x: 1000, y: 700 }, { f: 40, x: R.nomePaula.x, y: R.nomePaula.y, click: true }, { f: 100, x: R.nomePaula.x + 30, y: R.nomePaula.y + 40 }, { f: 128, x: R.askOk.x, y: R.askOk.y, click: true }, { f: 160, x: R.askOk.x + 60, y: R.askOk.y + 80 }]} />
      </Browser>
      <Caption from={10}>Nomes certos. Dois iguais? Ele pergunta e junta.</Caption>
    </>
  );
};

// ---------- 5 · pergunte à IA ----------
const IA = () => {
  const f = useCurrentFrame();
  const switched = f >= 31;
  const c = switched ? cam(f, 31, 80, { x: 900, y: 420, z: 1.5 }, { x: 970, y: 760, z: 1.75 }) : { x: 900, y: 420, z: 1.5 };
  const q = "O que ficou decidido?";
  const typedN = typedCount(q, f, 48, 14);
  const typingDone = typedN >= q.length;
  const sent = f >= 96;
  const reveal = lerp(f, 100, 134, 0, 1); // resposta "em streaming"
  return (
    <>
      <Browser camera={c} scale={0.9}>
        <Screen src={switched ? "05-ia" : "02-transcricao"} />
        {switched && (
          <>
            {/* cobre a conversa salva e revela aos poucos, como se a resposta estivesse chegando */}
            <div style={{ position: "absolute", left: R.chatLog.x - 4, top: R.chatLog.y + R.chatLog.h * reveal, width: R.chatLog.w + 8, height: R.chatLog.h * (1 - reveal) + 4, background: "#fff", opacity: sent ? 1 : 1 }} />
            {!sent && (
              <div style={{ position: "absolute", left: R.chatLog.x, top: R.chatLog.y + 4, width: R.chatLog.w, height: R.chatLog.h - 8, background: "#fff" }} />
            )}
            {/* campo de pergunta (o real fica na borda inferior da tela); cobre a faixa de sugestões */}
            <div style={{ position: "absolute", left: R.chatLog.x - 4, top: R.chatLog.y + R.chatLog.h, width: R.chatLog.w + 8, height: SCREEN_H - (R.chatLog.y + R.chatLog.h), background: "#fff" }} />
            <div style={{ position: "absolute", left: R.chatLog.x, top: 942, width: R.chatLog.w, height: 44, borderRadius: 12, border: "1.5px solid #d4d7dd", background: "#fff", display: "flex", alignItems: "center", padding: "0 14px", fontFamily: C.sans, fontSize: 16, color: "#1b1e24", boxShadow: "0 1px 2px rgba(16,24,40,.06)" }}>
              <Typing text={sent ? "" : q} start={48} cps={14} caret={!sent} />
              {sent ? <span style={{ color: "#9aa0a6" }}>Pergunte qualquer coisa sobre esta reunião…</span> : null}
              <span style={{ marginLeft: "auto", width: 28, height: 28, borderRadius: 8, background: typingDone && !sent ? C.accent : "#e9ecf1", display: "inline-block" }} />
            </div>
          </>
        )}
        <Cursor keys={[{ f: 0, x: 1100, y: 600 }, { f: 26, x: R.tabIa.x, y: R.tabIa.y, click: true }, { f: 60, x: 1200, y: 870 }, { f: 92, x: R.chatLog.x + R.chatLog.w - 22, y: 958, click: true }, { f: 130, x: 1300, y: 900 }]} />
      </Browser>
      <Caption from={36}>Pergunte à reunião. A resposta vem da transcrição.</Caption>
    </>
  );
};

// ---------- 6 · ata e análise ----------
const AtaAnalise = () => {
  const f = useCurrentFrame();
  const first = f < 40;
  const c = first ? cam(f, 0, 40, { x: 970, y: 480, z: 1.6 }, { x: 970, y: 520, z: 1.8 }) : cam(f, 40, 80, { x: 970, y: 430, z: 1.55 }, { x: 980, y: 500, z: 1.75 });
  return (
    <>
      <Browser camera={c} tilt={{ ry: first ? 0 : 10, rx: first ? 0 : 2 }} scale={0.9}>
        <Screen src={first ? "05-ia" : "07-analise"} />
      </Browser>
      <Caption from={6}>{first ? "A ata pronta quando a chamada acaba." : "Quem falou quanto, perguntas, trocas de turno."}</Caption>
    </>
  );
};

// ---------- 7 · dentro do Meet ----------
const Tile: React.FC<{ color: string; ini: string; name: string; speaking?: boolean }> = ({ color, ini, name, speaking }) => (
  <div style={{ position: "relative", borderRadius: 16, background: "#2c2d31", display: "flex", alignItems: "center", justifyContent: "center", outline: speaking ? "4px solid #8ab4f8" : "none", outlineOffset: -4 }}>
    <div style={{ width: 120, height: 120, borderRadius: 60, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: C.sans, fontWeight: 700, fontSize: 48, color: "#0b1530" }}>{ini}</div>
    <div style={{ position: "absolute", left: 16, bottom: 12, fontFamily: C.sans, fontSize: 20, color: "#e8eaed", background: "rgba(0,0,0,.35)", padding: "3px 12px", borderRadius: 999 }}>{name}</div>
  </div>
);
const Meet = () => {
  const f = useCurrentFrame();
  const rx = lerp(f, 0, 60, 16, 4);
  const z = lerp(f, 0, 60, 1.18, 1.0);
  const speaking = Math.floor(f / 20) % 4;
  return (
    <>
      <Browser camera={{ x: 800, y: 500, z }} tilt={{ rx, ry: -6 }} scale={0.9} url="meet.google.com/abc-defg-hij">
        <div style={{ position: "absolute", inset: 0, background: "#202124" }}>
          <div style={{ position: "absolute", left: 40, right: 40, top: 40, bottom: 110, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 20 }}>
            <Tile color="#a3e635" ini="AT" name="Ana Teixeira" speaking={speaking === 0} />
            <Tile color="#60a5fa" ini="BL" name="Bruno Lima" speaking={speaking === 1} />
            <Tile color="#f472b6" ini="T" name="Você" speaking={speaking === 2} />
            <Tile color="#fbbf24" ini="PF" name="Paula Franco" speaking={speaking === 3} />
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 90, background: "#202124", borderTop: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
            {["#3c4043", "#3c4043", "#ea4335", "#3c4043", "#3c4043"].map((c, i) => (
              <div key={i} style={{ width: 56, height: 56, borderRadius: 28, background: c }} />
            ))}
          </div>
          <Img src={staticFile("capturas/widget.png")} style={{ position: "absolute", right: 36, bottom: 120, width: 372, height: 362, borderRadius: 18, boxShadow: "0 30px 80px rgba(0,0,0,.6)" }} />
        </div>
      </Browser>
      <Caption from={8}>Dentro do Meet, do Teams, do Zoom e dos huddles do Slack.</Caption>
    </>
  );
};

// ---------- 8 · fecho ----------
const Fim = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 14, stiffness: 110 } });
  const s2 = spring({ frame: f - 14, fps, config: { damping: 16, stiffness: 110 } });
  const s3 = spring({ frame: f - 26, fps, config: { damping: 16, stiffness: 110 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <Img src={staticFile("img/icon.png")} style={{ width: 160, height: 160, borderRadius: 40, transform: `scale(${s})`, boxShadow: "0 30px 80px rgba(0,0,0,.5)" }} />
      <div style={{ fontFamily: C.serif, fontStyle: "italic", fontWeight: 500, fontSize: 104, color: C.ink, marginTop: 18, letterSpacing: -3, opacity: s, transform: `translateY(${(1 - s) * 20}px)` }}>Escribanote</div>
      <div style={{ fontFamily: C.sans, fontSize: 30, color: C.ink2, opacity: s2, transform: `translateY(${(1 - s2) * 20}px)` }}>Grátis para instalar · Chrome e Edge · Tudo fica no seu computador</div>
      <div style={{ marginTop: 34, fontFamily: C.sans, fontWeight: 800, fontSize: 34, color: "#fff", background: C.accent, padding: "16px 40px", borderRadius: 999, opacity: s3, transform: `scale(${0.8 + 0.2 * s3})` }}>escribanote.com</div>
    </AbsoluteFill>
  );
};

export const Lancamento = () => {
  return (
    <AbsoluteFill style={{ background: `radial-gradient(90% 70% at 50% 30%, ${C.bg2} 0%, ${C.bg} 60%, #110c09 100%)` }}>
      <Fonts />
      <Sequence from={S.hook} durationInFrames={S.lista - S.hook}><Fade outAt={82}><Gancho /></Fade></Sequence>
      <Sequence from={S.lista} durationInFrames={S.trans - S.lista}><Fade outAt={104}><Lista /></Fade></Sequence>
      <Sequence from={S.trans} durationInFrames={S.ren - S.trans}><Fade outAt={114}><Transcricao /></Fade></Sequence>
      <Sequence from={S.ren} durationInFrames={S.ia - S.ren}><Fade outAt={154}><Renomear /></Fade></Sequence>
      <Sequence from={S.ia} durationInFrames={S.ata - S.ia}><Fade outAt={134}><IA /></Fade></Sequence>
      <Sequence from={S.ata} durationInFrames={S.meet - S.ata}><Fade outAt={74}><AtaAnalise /></Fade></Sequence>
      <Sequence from={S.meet} durationInFrames={S.fim - S.meet}><Fade outAt={54}><Meet /></Fade></Sequence>
      <Sequence from={S.fim} durationInFrames={DURATION - S.fim}><Fade inF={10}><Fim /></Fade></Sequence>

      {/* trilha e efeitos */}
      <Audio src={staticFile("audio/musica.mp3")} volume={(fr) => interpolate(fr, [0, 20, DURATION - 40, DURATION - 2], [0, 0.55, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
      <Sequence from={2}><Audio src={staticFile("audio/sfx-whoosh.mp3")} volume={0.5} /></Sequence>
      {[S.lista + 42, S.ren + 40, S.ren + 128, S.ia + 26, S.ia + 92].map((at) => (
        <Sequence key={at} from={at}><Audio src={staticFile("audio/sfx-pop.mp3")} volume={0.6} /></Sequence>
      ))}
      <Sequence from={S.ata + 4}><Audio src={staticFile("audio/sfx-chime.mp3")} volume={0.45} /></Sequence>
      <Sequence from={S.meet}><Audio src={staticFile("audio/sfx-page.mp3")} volume={0.4} /></Sequence>
      <Sequence from={S.fim}><Audio src={staticFile("audio/sfx-whoosh.mp3")} volume={0.4} /></Sequence>
    </AbsoluteFill>
  );
};
