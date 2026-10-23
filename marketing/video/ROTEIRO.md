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
