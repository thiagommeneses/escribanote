#!/usr/bin/env bash
# Gera as narrações cena a cena com a ElevenLabs (CLI oficial, login já feito).
# Uso: audio/gerar.sh masc|fem|dueto
set -euo pipefail
cd "$(dirname "$0")"
e() { npx -y @elevenlabs/cli@1.7.0 "$@"; }
kind="$1"
mkdir -p "$kind"
python3 - "$kind" <<'PY'
import json, subprocess, sys, os
kind = sys.argv[1]
r = json.load(open("roteiro.json"))
V = r["vozes"]
settings = {"stability": 0.45, "similarity_boost": 0.8, "style": 0.3, "use_speaker_boost": True, "speed": 1.04}
def run(args, out):
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        print("já existe", out); return
    print("gerando", out)
    subprocess.run(["npx", "-y", "@elevenlabs/cli@1.7.0", *args, "-o", out, "-q"], check=True)
if kind in ("masc", "fem"):
    for i, text in enumerate(r["solo"], 1):
        body = {"text": text, "model_id": "eleven_multilingual_v2", "voice_settings": settings}
        run(["text-to-speech", "convert", "--voice-id", V[kind]["id"], "--json", json.dumps(body), "--output-format", "mp3_44100_128"], f"{kind}/{i}.mp3")
else:
    for i, scene in enumerate(r["dueto"], 1):
        inputs = [{"text": t, "voice_id": V["dueto_" + who]["id"]} for who, t in scene]
        body = {"inputs": inputs, "model_id": "eleven_v3", "language_code": "pt", "settings": {"stability": 0.5, "use_speaker_boost": True}}
        run(["text-to-dialogue", "convert", "--json", json.dumps(body), "--output-format", "mp3_44100_128"], f"dueto/{i}.mp3")
PY
