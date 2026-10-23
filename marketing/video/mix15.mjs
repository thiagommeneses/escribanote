// Mixa a versão de 15 s: narração (locutora), bossa nova real de fundo com ducking e efeitos de papel.
import { spawnSync, execFileSync } from "node:child_process";
import { resolve } from "node:path";
const A = (f) => resolve(import.meta.dirname, "audio", "v15", f);
const A0 = (f) => resolve(import.meta.dirname, "audio", f);
const silent = resolve(import.meta.dirname, "out", "_caderno15-mudo.mp4");
const total = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", silent]).toString().trim());
const MUSIC_OFFSET = 40.0; // trecho com o groove já estabelecido
const sfx = [
  ["sfx-thud.mp3", 0.40, 1.0], ["sfx-page.mp3", 1.05, 0.5], ["sfx-pen.mp3", 1.75, 0.35], ["sfx-pen.mp3", 2.95, 0.35],
  ["sfx-page.mp3", 4.2, 0.6], ["sfx-pen.mp3", 5.25, 0.3], ["sfx-pen.mp3", 7.3, 0.3], ["sfx-page.mp3", 9.5, 0.6],
  ["sfx-stamp.mp3", 11.6, 0.9], ["sfx-thud.mp3", 12.95, 0.45],
];
const inputs = ["-ss", String(MUSIC_OFFSET), "-i", A("musica-bossa-antigua.mp3"), "-i", A("narracao-15.mp3"), "-i", A0("sfx-whoosh.mp3")];
const f = [];
f.push(`[1:a]adelay=60|60,apad,atrim=0:${total.toFixed(2)},loudnorm=I=-15:TP=-1.5:LRA=8[voz]`);
f.push(`[2:a]volume=0.4,adelay=13050|13050,apad,atrim=0:${total.toFixed(2)}[wh]`);
let n = 3; const labels = ["[wh]"];
for (const [file, at, vol] of sfx) { inputs.push("-i", A(file)); f.push(`[${n}:a]volume=${vol},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)},apad,atrim=0:${total.toFixed(2)}[s${n}]`); labels.push(`[s${n}]`); n++; }
f.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0[sfx]`);
f.push(`[0:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.8,afade=t=in:d=0.6,afade=t=out:st=${(total - 1.4).toFixed(2)}:d=1.4[mus]`);
f.push(`[voz]asplit[vA][vB]`);
f.push(`[mus][vA]sidechaincompress=threshold=0.04:ratio=4:attack=30:release=450:makeup=1[duck]`);
f.push(`[duck][vB][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1:LRA=11[mix]`);
const out = resolve(import.meta.dirname, "out", "escribanote-15s-caderno.mp4");
const args = ["-y", "-loglevel", "error", ...inputs, "-i", silent, "-filter_complex", f.join(";"), "-map", `${n}:v`, "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", out];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
console.log("MP4:", out);
