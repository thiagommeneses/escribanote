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
