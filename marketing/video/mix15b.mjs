// Mixa a versão de 15 s: narração (locutora), bossa nova real de fundo com ducking e efeitos de papel.
import { spawnSync, execFileSync } from "node:child_process";
import { resolve } from "node:path";
const A = (f) => resolve(import.meta.dirname, "audio", "v15b", f);
const A0 = (f) => resolve(import.meta.dirname, "audio", f);
const silent = resolve(import.meta.dirname, "out", "_editorial15-mudo.mp4");
const total = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", silent]).toString().trim());
const MUSIC_OFFSET = 40.0; // trecho com o groove já estabelecido
const V = (f) => resolve(import.meta.dirname, "audio", "v15", f);
const sfx = [
  [V("sfx-thud.mp3"), 0.12, 0.8], [V("sfx-thud.mp3"), 0.72, 0.5],
  [A0("sfx-pop.mp3"), 2.06, 0.5], [A0("sfx-pop.mp3"), 2.38, 0.5], [A0("sfx-pop.mp3"), 2.73, 0.6],
  [A0("sfx-whoosh.mp3"), 3.38, 0.6], [A0("sfx-pop.mp3"), 5.68, 0.4], [A0("sfx-pop.mp3"), 5.88, 0.4], [A0("sfx-pop.mp3"), 6.08, 0.4],
  [A0("sfx-whoosh.mp3"), 7.08, 0.6], [V("sfx-stamp.mp3"), 9.13, 0.9],
  [A0("sfx-whoosh.mp3"), 10.66, 0.6], [A0("sfx-whoosh.mp3"), 12.11, 0.6], [A0("sfx-pop.mp3"), 13.18, 0.4], [A0("sfx-pop.mp3"), 13.43, 0.4], [A0("sfx-chime.mp3"), 13.9, 0.45],
];
const inputs = ["-ss", String(MUSIC_OFFSET), "-i", A("musica-bossa-antigua.mp3"), "-i", A("narracao.mp3"), "-i", A0("sfx-whoosh.mp3")];
const f = [];
f.push(`[1:a]adelay=0|0,apad,atrim=0:${total.toFixed(2)},loudnorm=I=-15:TP=-1.5:LRA=8[voz]`);
f.push(`[2:a]volume=0.4,adelay=13050|13050,apad,atrim=0:${total.toFixed(2)}[wh]`);
let n = 3; const labels = ["[wh]"];
for (const [file, at, vol] of sfx) { inputs.push("-i", file); f.push(`[${n}:a]volume=${vol},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)},apad,atrim=0:${total.toFixed(2)}[s${n}]`); labels.push(`[s${n}]`); n++; }
f.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0[sfx]`);
f.push(`[0:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.8,afade=t=in:d=0.6,afade=t=out:st=${(total - 1.4).toFixed(2)}:d=1.4[mus]`);
f.push(`[voz]asplit[vA][vB]`);
f.push(`[mus][vA]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=450:makeup=1[duck]`);
f.push(`[duck][vB][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1:LRA=11[mix]`);
const out = resolve(import.meta.dirname, "out", "escribanote-15s-editorial.mp4");
const args = ["-y", "-loglevel", "error", ...inputs, "-i", silent, "-filter_complex", f.join(";"), "-map", `${n}:v`, "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", out];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
console.log("MP4:", out);
