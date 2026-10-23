#!/usr/bin/env bash
# Compila o ajudante com o compilador C# que já vem no Windows (.NET Framework 4.x) e monta o zip.
# Roda no WSL (usa o csc.exe pelo interop) ou no PowerShell do Windows (adapte os caminhos).
#   NAUDIO=/caminho/NAudio.dll ./build.sh    (NAudio 1.10.0, lib/net35, do pacote NuGet "NAudio")
set -euo pipefail
cd "$(dirname "$0")"
NAUDIO="${NAUDIO:-bin/NAudio.dll}"
[ -f "$NAUDIO" ] || { echo "Informe NAUDIO=/caminho/NAudio.dll (NAudio 1.10.0, lib/net35)"; exit 1; }
mkdir -p bin && cp -f "$NAUDIO" bin/NAudio.dll
CSC="/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
"$CSC" /nologo /target:exe /platform:anycpu /optimize+ "/out:$(wslpath -w bin/EscribanoteAudio.exe)" "/r:$(wslpath -w bin/NAudio.dll)" "$(wslpath -w EscribanoteAudio.cs)"
cp -f instalar.ps1 desinstalar.ps1 Instalar.cmd Desinstalar.cmd LEIA-ME.txt LICENSE-NAudio.txt bin/
python3 - <<'PY'
import zipfile, os
os.chdir("bin")
with zipfile.ZipFile("escribanote-audio-windows.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in ["EscribanoteAudio.exe", "NAudio.dll", "instalar.ps1", "desinstalar.ps1", "Instalar.cmd", "Desinstalar.cmd", "LEIA-ME.txt", "LICENSE-NAudio.txt"]:
        z.write(f, "escribanote-audio/" + f)
print("bin/escribanote-audio-windows.zip pronto")
PY
