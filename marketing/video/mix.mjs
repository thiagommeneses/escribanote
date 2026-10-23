// Monta as versões narradas: calcula a duração de cada cena pela narração, renderiza o vídeo
// com essas durações e mixa voz + música (com ducking) + efeitos.
//   CHROME=... node mix.mjs masc|fem|dueto
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const kind = process.argv[2];
if (!["masc", "fem", "dueto"].includes(kind)) { console.error("uso: node mix.mjs masc|fem|dueto"); process.exit(2); }
const A = (f) => resolve(import.meta.dirname, "audio", f);
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

// duração mínima visual de cada cena e folga depois da fala
const MIN = [3.0, 5.6, 5.4, 5.8, 4.4, 3.4, 4.2];
const LEAD = 0.35; // a fala começa um pouco depois do corte
const TAIL = 0.55;
const clips = MIN.map((_, i) => A(`${kind}/${i + 1}.mp3`));
const durs = clips.map((c, i) => Math.max(MIN[i], dur(c) + LEAD + TAIL));
const starts = durs.map((_, i) => durs.slice(0, i).reduce((a, b) => a + b, 0));
const total = durs.reduce((a, b) => a + b, 0);
console.log(kind, "cenas:", durs.map((d) => d.toFixed(2)).join(", "), "total", total.toFixed(1), "s");

// 1) vídeo mudo com as durações desta narração
const silent = resolve(import.meta.dirname, "out", `_${kind}-mudo.mp4`);
if (!existsSync(silent) || process.argv.includes("--render")) {
  const r = spawnSync("node", [resolve(import.meta.dirname, "render.mjs"), "shorts", silent, `--d=${durs.map((d) => d.toFixed(3)).join(",")}`], { stdio: "inherit", env: process.env });
  if (r.status !== 0) process.exit(r.status);
}

// 2) mixagem
const music = A("musica.mp3");
const mDur = dur(music);
const CONTENT_END = 34.0; // a música termina (fade natural) por volta de 34 s
const tailLen = 8.4; // trecho final usado para fechar junto com o vídeo
const bodyLen = Math.max(8, total - tailLen + 0.8);
const bodyEnd = Math.min(bodyLen, CONTENT_END - tailLen);
// corpo: 0 → bodyEnd ; se o vídeo é mais longo que a música, repete a parte da virada antes da cauda
const loopNeeded = Math.max(0, total - CONTENT_END);
const inputs = ["-i", music];
let filters = [];
let musicChain;
if (loopNeeded > 0.5) {
  const loopStart = 21.4; // duas barras depois da virada (112 BPM)
  filters.push(`[0:a]atrim=0:${(CONTENT_END - tailLen).toFixed(2)},asetpts=PTS-STARTPTS[m1]`);
  filters.push(`[0:a]atrim=${loopStart}:${(loopStart + loopNeeded + 0.8).toFixed(2)},asetpts=PTS-STARTPTS[m2]`);
  filters.push(`[0:a]atrim=${(CONTENT_END - tailLen).toFixed(2)}:${mDur.toFixed(2)},asetpts=PTS-STARTPTS[m3]`);
  filters.push(`[m1][m2]acrossfade=d=0.8:c1=tri:c2=tri[m12]`);
  filters.push(`[m12][m3]acrossfade=d=0.8:c1=tri:c2=tri[mus0]`);
  musicChain = "[mus0]";
} else {
  filters.push(`[0:a]atrim=0:${mDur.toFixed(2)},asetpts=PTS-STARTPTS[mus0]`);
  musicChain = "[mus0]";
}
// voz: cada clipe no seu tempo
clips.forEach((c, i) => { inputs.push("-i", c); filters.push(`[${i + 1}:a]adelay=${Math.round((starts[i] + LEAD) * 1000)}|${Math.round((starts[i] + LEAD) * 1000)},apad[v${i}]`); });
filters.push(`${clips.map((_, i) => `[v${i}]`).join("")}amix=inputs=${clips.length}:normalize=0,atrim=0:${total.toFixed(2)},loudnorm=I=-16:TP=-1.5:LRA=9[voz]`);
// efeitos: pop no Salvar (cena 3 +2.6) e no Mesclar (+3.9), chime quando a ata aparece (cena 4 +1.7), whoosh na virada da cena 1 → 2
const sfx = [
  ["sfx-whoosh.mp3", starts[1] - 0.25, 0.5], ["sfx-pop.mp3", starts[2] + 2.6, 0.7], ["sfx-pop.mp3", starts[2] + 3.9, 0.7], ["sfx-chime.mp3", starts[3] + 1.7, 0.55],
];
let n = clips.length + 1;
const sfxLabels = [];
for (const [f, at, vol] of sfx) { inputs.push("-i", A(f)); filters.push(`[${n}:a]volume=${vol},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)},apad[s${n}]`); sfxLabels.push(`[s${n}]`); n++; }
filters.push(`${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:normalize=0,atrim=0:${total.toFixed(2)}[sfx]`);
// música: nível, ducking pela voz, fade final
filters.push(`${musicChain}volume=0.55,atrim=0:${total.toFixed(2)}[mA]`);
filters.push(`[voz]asplit[vA][vB]`);
filters.push(`[mA][vA]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600:makeup=1[duck]`);
filters.push(`[duck]afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[musf]`);
filters.push(`[musf][vB][sfx]amix=inputs=3:normalize=0:weights=1 1 1,loudnorm=I=-14:TP=-1:LRA=11[mix]`);
const out = resolve(import.meta.dirname, "out", `escribanote-shorts-narracao-${kind}.mp4`);
const vidIdx = inputs.length / 2; // o vídeo entra por último
const args = ["-y", "-loglevel", "error", ...inputs, "-i", silent, "-filter_complex", filters.join(";"), "-map", `${vidIdx}:v`, "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", out];
const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
console.log("MP4:", out);
