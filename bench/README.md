# Benchmark de transcrição

Mede a qualidade do modo alta precisão (Whisper local) do Escribanote com o pipeline real:
segmentador, filtros e modelo rodam dentro da extensão, num Chromium sem interface, sobre casos
com verdade conhecida. O CI (`.github/workflows/bench.yml`) roda em todo push e pull request e
falha quando algum caso fica abaixo de `limiares.json`.

```
CHROME=/caminho/chrome node bench/run.mjs                 # todos os casos, modelo base
CHROME=... node bench/run.mjs --modelo small --caso eco   # um caso, outro modelo
CHROME=... node bench/run.mjs --verificar                 # compara com os limiares (como no CI)
```

O modelo é baixado uma vez para `bench/.perfil` (ignorado pelo git).

## Como gravar um caso novo (vozes reais)

1. Crie `bench/casos/<nome>/`.
2. Grave as duas faixas separadas, **16 kHz, mono, 16 bits, WAV**: `mic.wav` (quem usa o Escribanote)
   e `aba.wav` (os outros participantes). As duas precisam começar no mesmo instante. Uma forma
   simples: Audacity com duas trilhas, exportar cada trilha com "Exportar áudio selecionado".
   Um caso pode ter só uma faixa (`"mic": null`).
3. Escreva `caso.json`:
   ```json
   { "descricao": "Chamada com caixa de som: a voz da Ana vaza para o microfone",
     "faixas": { "aba": "aba.wav", "mic": "mic.wav" } }
   ```
4. Escreva `verdade.json` com cada fala, em milissegundos desde o início:
   ```json
   { "linhas": [
     { "quem": "Ana", "lado": "aba", "inicio": 1200, "fim": 4800, "texto": "Bom dia, vamos começar pelo backlog." },
     { "quem": "Thiago", "lado": "mic", "inicio": 5000, "fim": 7900, "texto": "Pode ser, o deploy de sexta ficou pendente." }
   ] }
   ```
   O texto é o que foi dito de fato, com a grafia certa dos termos. A pontuação não conta.
5. Rode o caso, veja a pontuação e acrescente os limiares em `limiares.json`, alguns pontos abaixo
   do obtido com o modelo `base`, para o CI ter margem.

## Métricas

| coluna | significado |
| --- | --- |
| encontradas | palavras da verdade que apareceram na transcrição a até 3 s do momento certo |
| lado | das encontradas, quantas saíram na faixa certa (microfone ou aba) |
| vazamento | palavras ditas pelos outros que apareceram em trechos do microfone no mesmo momento (eco) |
| linhas | trechos produzidos; no caso `silencio` tem de ser zero |
| segundos | tempo de transcrição (sem contar a carga do modelo) |

## Casos previstos no TDD

fone-de-ouvido, caixa-de-som, duas-pessoas-no-mic, musica-de-fundo, importado-misto, silencio,
mic-ruidoso, termos-tecnicos. Hoje existem `silencio` (gerado) e `fala-teste` (clipe real de 3,6 s);
os demais entram conforme a equipe gravar as vozes.
