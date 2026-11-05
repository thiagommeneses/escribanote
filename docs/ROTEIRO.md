# Roteiro do Escribanote

Montado em 2026-11-05 a partir das queixas mais comuns sobre transcritores de reunião (Otter, Fireflies, tl;dv,
Fathom, Tactiq, Read.ai, Zoom AI, Teams) e de projetos abertos no GitHub (diart, pyannote, wespeaker,
sherpa-onnx, whisperX, transformers.js, WebLLM, meetily). O que já saiu está no `extension/CHANGELOG.md`.

## Feito

| Queixa | Resposta | Versão |
|---|---|---|
| Mesma pessoa vira dois falantes; nomes duplicados (`keep_…`, reconexão) | junção por nome, agrupamento de vozes novo, "manter separados" | 0.9.45–0.9.47 |
| Resumo de IA inventado ou genérico | ata e chat citam o horário de cada ponto (link) e dizem "não consta" | 0.9.47 |
| Gravar sem avisar / LGPD | megafone pisca até o aviso; aviso automático; página de privacidade | 0.9.48 |
| Editar a transcrição dá trabalho | localizar e substituir em tudo, um Ctrl+Z | 0.9.49 |
| Nomes trocados no começo da reunião | perfis de voz locais e opcionais (Pro) | 0.9.50 |
| Consumo de CPU e bateria | alta precisão "Automático" (computador e bateria) | 0.9.51 |
| Busca e perguntas entre reuniões | "Perguntar sobre" esta + anteriores / 5 últimas | 0.9.52 |
| Integrações | webhook pós-reunião (Zapier, Make, n8n…) | 0.9.53 |
| Bot intrusivo, limite de minutos, só o organizador transcreve | posicionamento no site | site |

## Avaliado e adiado

### Falante por palavra (como no whisperX)
- **O que daria:** cortar uma fala que mistura duas pessoas no ponto exato da troca.
- **Custo:** o Whisper do transformers.js só dá horário por palavra com exportações ONNX que trazem as
  "alignment heads" (`return_timestamps: "word"`); exige trocar os modelos baixados (`HQ_MODELS`) e roda
  ~20–30% mais devagar. Hoje o pyannote já divide o trecho por turno antes do Whisper (`speakers.split`),
  o que resolve o caso comum (duas pessoas no mesmo trecho de áudio).
- **Decisão:** adiar. Retomar se o Diagnóstico mostrar muitos blocos com duas vozes, ou quando o
  onnx-community publicar o whisper-small com horários por palavra em q4.

### IA local no navegador (WebLLM) para o plano Free
- **O que daria:** ata e perguntas sem chave e sem Pro, 100% local.
- **Custo:** download de 1–2 GB por modelo (Qwen/Llama 1–3B), só com placa de vídeo (WebGPU), e qualidade
  fraca em português para atas longas; concorre com o Whisper pela GPU durante a reunião.
- **Decisão:** adiar. Quando valer, entrar como "Ata rápida local (experimental)" só depois da reunião,
  com o download pedido à parte — sem tirar a IA do Pro (ver planos Free/Pro).

## Próximos candidatos
- Envio direto para Notion e Google Docs (hoje, pelo webhook + Zapier/Make).
- Integração com o calendário para dar nome à reunião (sem entrar sozinho em nenhuma).
- Teste do gravador do computador com áudio real no CI (`test/e2e-recorder.mjs` precisa de dois .wav).
