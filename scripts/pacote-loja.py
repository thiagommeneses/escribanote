#!/usr/bin/env python3
"""Pacote da extensão para a Chrome Web Store.

A loja recusa o campo "key" no manifest.json; ele sai do pacote. No PRIMEIRO envio, a chave privada
vai na raiz do zip como key.pem: a loja usa essa chave e a extensão mantém o mesmo ID da instalação
pelo zip do site (ohbnmfogdcbgegnpcaphidkjinplednd). Nos envios seguintes, sem a chave.

  python3 scripts/pacote-loja.py                       # atualização
  python3 scripts/pacote-loja.py --chave ../escribanote-chave-privada.pem   # primeiro envio

Gera loja/escribanote-loja-<versão>.zip (pasta fora do git).
"""
import argparse, json, os, subprocess, sys, zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
ap = argparse.ArgumentParser()
ap.add_argument("--chave", help="chave privada (.pem) para manter o ID no primeiro envio")
args = ap.parse_args()

manifest = json.load(open("extension/manifest.json", encoding="utf-8"))
manifest.pop("key", None)
if len(manifest["description"]) > 132:
    sys.exit(f"descrição com {len(manifest['description'])} caracteres; a loja aceita até 132")
version = manifest["version"]
files = subprocess.run(["git", "ls-files", "extension"], capture_output=True, text=True, check=True).stdout.split()
files = [f for f in files if not f.startswith("extension/test/") and not os.path.basename(f).startswith("package") and f != "extension/manifest.json"]
os.makedirs("loja", exist_ok=True)
out = f"loja/escribanote-loja-{version}{'-com-chave' if args.chave else ''}.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    for f in files:
        z.write(f, f[len("extension/"):])
    if args.chave:
        z.write(args.chave, "key.pem")
print(out, f"({len(files) + 1} arquivos{', com key.pem' if args.chave else ''})")
