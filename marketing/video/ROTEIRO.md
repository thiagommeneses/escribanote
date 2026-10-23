# Vídeo de lançamento — Escribanote (9:16)

Dois cortes gerados a partir do mesmo `lancamento.html`:

| Corte | Duração | Uso |
|---|---|---|
| `out/escribanote-shorts.mp4` | 34 s | YouTube Shorts, Reels, TikTok |
| `out/escribanote-story.mp4` | 15 s | Instagram Story (um card só) |

Cada um tem uma variante `-com-som.mp4`, com uma trilha ambiente sintetizada bem baixa.
A versão muda é a recomendada se você for colocar uma música da biblioteca do app.

## Roteiro (Shorts, 34 s)

| Tempo | Cena | Texto na tela |
|---|---|---|
| 0–3 s | Enxurrada de legendas passando rápido, desfocadas | **Uma hora de reunião. Zero *anotações*.** |
| 3–9 s | Janela do Meet com 4 pessoas; o widget do Escribanote transcreve ao vivo, nome por nome, com o quadro de quem fala acendendo | **Transcreve ao vivo. *Com quem disse o quê*.** / Legendas do Meet viram transcrição com nome e horário. Teams, Zoom e Slack também. |
| 9–15 s | Chips dos participantes; "Participante 428" é renomeado para Thiago; a pergunta "Mesclar com Thiago?"; os chips se juntam | **Nomes certos. *E se repetir, você mescla*.** / Clique no nome, digite o certo. Dois chips com a mesma pessoa? Ele pergunta e junta. |
| 15–21 s | Botão "Encerrar transcrição" é pressionado (onda); a ata aparece sendo escrita: resumo, decisões, pendências | **Acabou a chamada? *A ata já está pronta*.** / Resumo, decisões e pendências escritos pela IA, com o texto original guardado. |
| 21–26 s | Canal do Slack: a ata postada pelo app; pergunta no thread; resposta do Escribanote citando a transcrição | **Publica no Slack. *E responde no thread*.** |
| 26–30 s | Cadeado; três checks | **Tudo fica *no seu computador*.** / Reconhecimento de voz local, com Whisper · Nada sai da máquina sem você mandar · Chrome e Edge · Meet, Teams, Zoom e Slack |
| 30–34 s | Ícone, nome, tagline, URL | **Escribanote** — Cada palavra da reunião, anotada. / escribanote.meneseslabs.com.br / Grátis para instalar. Pro: ata com IA, nuvem e Slack. |

O corte Story usa as cenas 1, 2, 4 e 7 (gancho, transcrição ao vivo, ata, CTA).

## Legenda sugerida para o post

> Uma hora de reunião e ninguém anotou? O Escribanote transcreve o Meet, o Teams, o Zoom e os huddles do Slack ao vivo, com o nome de quem falou, e entrega a ata quando a chamada acaba. Tudo no seu computador. Grátis para instalar no Chrome e no Edge: escribanote.meneseslabs.com.br
>
> #reuniões #produtividade #googlemeet #slack #transcrição #ata #ia

## Como regerar

```bash
cd marketing/video
CHROME=/caminho/do/chrome node render.mjs shorts          # out/escribanote-shorts.mp4
CHROME=/caminho/do/chrome node render.mjs story           # out/escribanote-story.mp4
CHROME=/caminho/do/chrome node render.mjs shorts --stills # um PNG por segundo em out/, para revisar
```

Para ver a animação em tempo real, abra `lancamento.html` no navegador (`?v=story` para o corte curto).
As cenas são funções de tempo em `lancamento.html`: cada uma recebe o tempo local e posiciona tudo,
então o render é determinístico quadro a quadro (30 fps, 1080×1920, H.264).

## Versões narradas (ElevenLabs)

| Arquivo | Voz | Duração |
|---|---|---|
| `out/escribanote-shorts-narracao-masc.mp4` | Arnold (Br), masculina profissional | 44 s |
| `out/escribanote-shorts-narracao-fem.mp4` | Bia, feminina confiante | 45 s |
| `out/escribanote-shorts-narracao-dueto.mp4` | Arnold + Roberta, alternando frases | 45 s |

Trilha: instrumental de lançamento composta pela ElevenLabs Music (`audio/musica.mp3`, 40 s, 112 BPM:
piano e pads na entrada, groove aos 8 s, virada aos 17 s, final limpo). Efeitos de interface
(`audio/sfx-*.mp3`): whoosh na passagem para a transcrição, pop nos cliques de Salvar e Mesclar,
chime quando a ata aparece. A música é abaixada automaticamente enquanto a voz fala (sidechain)
e o conjunto é normalizado em -14 LUFS, o padrão das plataformas.

Cada cena dura o tempo da fala mais uma folga, então as três versões têm cortes um pouco diferentes.
As narrações ficam em `audio/<voz>/<cena>.mp3` e os textos em `audio/roteiro.json`.

### Narração (solo)

1. Uma hora de reunião. E ninguém anotou nada.
2. O Escribanote transcreve ao vivo, direto do Meet, do Teams, do Zoom e do Slack. Com o nome de quem falou.
3. Nome errado? Clique e corrija. Duas vezes a mesma pessoa? Ele pergunta e junta.
4. Acabou a chamada? A ata já está pronta: resumo, decisões e pendências.
5. Publica no Slack. E responde às perguntas no thread.
6. E tudo fica no seu computador.
7. Escribanote. Grátis para instalar no Chrome e no Edge. Cada palavra da reunião, anotada.

No dueto as mesmas ideias são divididas entre as duas vozes (ver `audio/roteiro.json`).

### Como regerar

```bash
audio/gerar.sh masc        # ou fem, dueto — usa a CLI da ElevenLabs já autenticada; pula clipes existentes
CHROME=... node mix.mjs masc --render   # renderiza o vídeo com as durações desta narração e mixa
```

## Versão 15 s "Para tudo" — caderno Moleskine em 3D (`out/escribanote-15s-caderno.mp4`)

Peça curta para Story, Reels e Shorts, com gancho nos primeiros segundos. Fonte: `caderno15.html`,
render com `node render.mjs caderno out/_caderno15-mudo.mp4 --file=caderno15.html` e mix com `node mix15.mjs`.

| Tempo | Imagem | Narração |
|---|---|---|
| 0,0–1,0 | Caderno preto de capa dura cai de cima e bate na mesa (tremor de câmera, baque); "PARA TUDO." estampado | **Para tudo.** |
| 1,0–3,0 | A capa abre; página pautada em branco; um "?" é desenhado à mão | Alguém anotou isso? |
| 3,0–4,2 | "não…" escrito em vermelho, sublinhado | Não? |
| 4,2–9,3 | A folha vira; a transcrição vai sendo escrita à mão, linha por linha; marca-texto nos nomes | Relaxa. O Escribanote anota a reunião inteira, com quem disse o quê. |
| 9,5–12,3 | A folha vira para a ata; "Decisões e pendências" com checks desenhados; carimbo "PRONTA" | Acabou a chamada? A ata já está pronta. |
| 12,4–13,1 | A capa fecha; o logo e o nome se acendem em relevo | Escribanote. |
| 13,1–15,6 | Etiqueta de papel kraft desce balançando com a URL; adesivos Grátis, Chrome, Edge | Grátis no Chrome e no Edge. |

- **Voz:** "Locutora Escribanote", desenhada no Voice Design da ElevenLabs (grave, potente, de rádio), salva na sua
  biblioteca com id `ECk9rxDeKPnryXzPgbeQ`. Narração em `eleven_v3` com marcações de emoção (`[surprised]`,
  `[curious]`, `[playful]`, `[warm]`, `[excited]`, `[confident]`). As três opções de timbre que o Voice Design gerou
  estão em `audio/v15/preview0-2.mp3` (a escolhida foi a 2, a mais grave).
- **Sincronia:** os tempos das cenas vêm do alinhamento forçado palavra a palavra (`audio/v15/align.json`).
- **Trilha:** "Bossa Antigua", Kevin MacLeod (incompetech.com), gravação real, licença Creative Commons BY 4.0.
  Ao publicar, inclua na descrição: `Música: "Bossa Antigua" Kevin MacLeod (incompetech.com) — CC BY 4.0`.
  Para trocar por uma composição da ElevenLabs (precisa de ~220 créditos), gere `audio/v15/musica15.mp3`
  com `elevenlabs music compose` e aponte `mix15.mjs` para ele.
- **Efeitos** (ElevenLabs SFX): baque do caderno, folha virando, caneta, carimbo.

## Vídeo de lançamento SaaS em Remotion (16:9, 27 s) — `marketing/remotion/`

Feito a partir do prompt em `marketing/video/PROMPT-lancamento-saas.md`. Projeto Remotion 4 (React), composição
`Lancamento`, 1920×1080, 30 fps, 810 quadros. As telas são capturas reais do app rodando em Chromium com uma reunião
fictícia ("Planejamento do Q4", Ana Teixeira, Bruno Lima, Paula Franco e Thiago), geradas por `capturas.mjs`, que
também grava as coordenadas dos elementos (`public/capturas/rects.json`) usadas pelo cursor e pela digitação.

| Quadros | Cena | Legenda |
|---|---|---|
| 0–90 | Título; a janela do app sobe com inclinação 3D e assenta | Cada palavra da reunião, *anotada*. |
| 90–200 | Zoom na lista; o cursor clica na reunião de hoje | Suas reuniões, do Meet ao Slack, num só lugar. |
| 200–320 | Ângulo 3/4; zoom na transcrição; destaque nos chips dos participantes | Quem disse o quê, ao vivo. |
| 320–480 | Cursor clica no nome, editor abre, "Paula Franco (PM)" é digitado, Salvar | Nomes certos. Dois iguais? Ele pergunta e junta. |
| 480–620 | Aba IA; pergunta digitada; resposta revelada como streaming | Pergunte à reunião. A resposta vem da transcrição. |
| 620–700 | Zoom na ata; corte para a análise com ângulo | A ata pronta quando a chamada acaba. / Quem falou quanto… |
| 700–760 | Janela do Meet vista de cima com o widget real no canto | Dentro do Meet, do Teams, do Zoom e dos huddles do Slack. |
| 760–810 | Ícone, nome, "Grátis para instalar · Chrome e Edge", URL | — |

Trilha: o instrumental de lançamento da ElevenLabs (`public/audio/musica.mp3`); efeitos de clique, whoosh e chime
nos eventos. Normalização final em -14 LUFS com ffmpeg.

```bash
cd marketing/remotion
npm install
CHROME=/caminho/chrome node capturas.mjs        # refaz as capturas do app (opcional)
npx remotion render src/index.ts Lancamento out/_render.mp4 --browser-executable=/caminho/chrome --concurrency=4
ffmpeg -i out/_render.mp4 -c:v copy -af loudnorm=I=-14:TP=-1:LRA=11 -c:a aac out/escribanote-lancamento-saas.mp4
npx remotion studio src/index.ts                 # pré-visualização interativa
```

## Versão 15 s editorial (`out/escribanote-15s-editorial.mp4`) — substitui a do caderno

Refeita do zero depois do feedback (visual genérico, movimento lento, cores feias). Nova direção: tipografia
editorial em cortes na batida, alternando preto e papel, com o **painel lateral real** do app como herói e os nomes
dos participantes saltando da tela. Fonte: `editorial15.html`; render `node render.mjs editorial out/_editorial15-mudo.mp4 --file=editorial15.html`; mix `node mix15b.mjs`.

| Tempo | Imagem | Narração (Bia, voz da biblioteca) |
|---|---|---|
| 0–2,0 | Preto. "UMA HORA" e "de reunião." batem na tela com tremor | Uma hora de reunião. |
| 2,0–3,55 | Papel. "E ninguém / anotou / nada." palavra a palavra; risco laranja | E ninguém anotou nada. |
| 3,55–7,25 | Chicote laranja; painel real da transcrição com zoom; chips destacados; etiquetas Ana / Bruno / Paula saltam | O Escribanote transcreve ao vivo… com o nome de quem falou. |
| 7,25–10,8 | Painel da ata; "ATA PRONTA." em itálico laranja bate com tremor | Acabou a chamada? A ata já está pronta. |
| 10,8–12,25 | Papel. Ícone e marca com mola | Escribanote. |
| 12,25–15,1 | Preto. "Grátis." · Chrome · Edge · URL · "Tudo fica no seu computador." | Grátis para instalar no Chrome e no Edge. |

Áudio: narração montada a partir das falas da Bia já gravadas (`audio/v15b/narracao.mp3`), porque a cota da
ElevenLabs zerou (renova em 17/11/2026); trilha "Bossa Antigua" (Kevin MacLeod, CC BY); efeitos de baque, pop,
whoosh, carimbo e chime nos cortes.
