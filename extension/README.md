# Escribanote 2.5 — Transcrição de Reuniões

Site: https://escribanote.meneseslabs.com.br

Extensão do Chrome (Manifest V3) que transcreve reuniões do **Google Meet**, **Microsoft Teams** e
**Zoom** (pelo navegador) e, com o gravador do computador, **huddles do Slack** e outros apps instalados.
É uma alternativa independente à Tactiq, escrita do zero, que guarda tudo no seu computador.

Até a versão 2.3 o projeto se chamava **Escriba** e, nas versões 2.4 e 2.5, **Reunilo**. A 2.6 só troca o
nome para Escribanote: o ID da extensão continua o mesmo, então reuniões, ajustes e a pasta de backup continuam valendo.

## Huddles do Slack e outros apps (novo na 2.2)

O **gravador do computador** transcreve o que toca em qualquer programa, inclusive o app do Slack para
Windows. Abra em **Reuniões › Gravar do computador** ou pela tela inicial do painel.

1. Clique em **Começar a gravar**.
2. Na janela do Chrome, escolha **Tela inteira** e ative **Compartilhar áudio do sistema**. O Chrome só libera o
   som junto com um compartilhamento de tela; a imagem não é usada.
3. Deixe a aba aberta. Para terminar, clique em **Parar e salvar** ou em "Parar de compartilhar", na barra do Chrome.

O som do computador vira **Participantes** e o seu microfone vira **Você**. Sem fone de ouvido, o microfone também
capta a voz dos outros na caixa de som: esse eco é reconhecido (mesmo texto, no mesmo momento) e descartado. A
gravação aparece na lista como qualquer reunião: destaques, notas, IA, análise e exportação funcionam iguais.

Limites: o Chrome só captura o áudio do sistema no **Windows** e no **ChromeOS**. O Slack não informa quem está
falando, então as outras pessoas aparecem juntas como "Participantes" (dá para renomear depois).

## Conta Escribanote Pro (novo na 2.5)

Opcional. Em **Ajustes › Conta Escribanote Pro › Entrar ou assinar o Pro**, o app web abre, a pessoa entra
pelo link enviado ao e-mail e clica em **Conectar este navegador**. O app entrega um token de dispositivo
à extensão por `externally_connectable` (só aceito vindo de `escribanote.meneseslabs.com.br`); o token fica
no service worker, e o app da extensão só vê o e-mail, o plano e os créditos.

- **Permissão antes de enviar:** depois de conectar, a lista mostra "Enviar as N reuniões deste computador?"
  (**Enviar todas** ou **Só as próximas**). Nada sobe antes disso.
- **Sincronização** (`src/lib/sync.js` + `background.js`): cada reunião salva entra na fila; reuniões ao
  vivo sobem a cada 2 minutos, as encerradas em segundos. O envio leva a versão conhecida; em conflito
  (409), a extensão baixa a versão da conta, mescla (falas, Whisper, notas e conversas somadas por id;
  título e ata do lado alterado por último) e reenvia. A cada 10 minutos baixa o que mudou na web ou em
  outro computador. Reunião apagada na conta continua no computador e não volta para a conta.
- **IA sem chave:** sem chave de API própria e com o Pro ativo, ata, revisão e perguntas usam os créditos
  da conta (a transcrição vai junto do pedido, então funciona também durante a reunião ao vivo).
  Com chave própria, nada muda: a chave tem prioridade e não gasta créditos.
- **Desconectar** remove o token, apaga o dispositivo da conta e mantém todas as reuniões no computador.



- **Backup automático numa pasta** (Ajustes → Backup e sincronização → Escolher pasta…). Cada reunião vira
  um arquivo `AAAA-MM-DD_HHhMM_<id>.json` dentro de uma subpasta `Escribanote` (as pastas `Escriba` e `Reunilo`, dos nomes antigos, também valem), gravado pelo service worker
  (em lotes de 15 s e na hora em que a reunião termina); apagar uma reunião apaga o arquivo. Os ajustes vão
  para `escribanote-ajustes.json` (sem a chave de API). Capturas de tela não entram no backup.
- **Restaurar**: depois de reinstalar ou em outro computador, "Restaurar de uma pasta de backup" (na tela
  inicial vazia ou em Ajustes) lê todos os `.json` da pasta, inclusive arquivos do "Exportar backup".
  Uma pasta do OneDrive/Google Drive leva as reuniões para outros computadores.
- **Permissão da pasta**: o Chrome pode pedir para confirmar o acesso depois de reiniciar; enquanto isso
  o backup fica pendente e a lista mostra "Retomar".
- **Ajustes na conta do Chrome** (`chrome.storage.sync`, em pedaços de 6 KB; vence a cópia alterada por
  último). A chave de API nunca é sincronizada. As transcrições não cabem no limite de 100 KB do sync.
- **ID fixo**: o `manifest.json` tem uma `key`, então a extensão tem o mesmo ID
  (`ohbnmfogdcbgegnpcaphidkjinplednd`) em qualquer pasta ou computador — necessário para o sync.

## Reconhecimento em três camadas (2.1)

1. **Captura direta das legendas**, versão por versão. Na leitura pela tela (plano B), o texto que o Meet
   descarta quando alguém fala rápido é acumulado em vez de perdido. Falas curtas repetidas ("sim", "ok")
   não são mais fundidas. O Escribanote **avisa quando a legenda está no idioma errado**, a causa nº 1 de
   transcrição ruim.
2. **Alta precisão local (Whisper):** captura o áudio da aba (e, se quiser, o seu microfone), corta nas
   pausas e transcreve de novo no próprio computador. Quem fala sem pausa é cortado no ponto mais
   silencioso, para não partir palavras. O falante vem das legendas e o trecho do Whisper substitui a
   legenda equivalente. Modelos:
   - Rápido (`whisper-base`, ~77 MB no processador);
   - **Equilibrado** (`whisper-small`, recomendado);
   - Máximo (`whisper-large-v3-turbo`, só com placa de vídeo/WebGPU).

   Para ativar, abra o painel pelo ícone na aba da reunião (o Chrome exige isso para liberar o áudio) e
   clique em **🎧 Alta precisão**, ou escolha um modelo em Ajustes para ligar sozinho.
3. **Revisão por IA com glossário:** corrige palavras mal reconhecidas pelo contexto e grafa nomes e
   siglas do seu glossário. O original fica guardado e as palavras trocadas aparecem marcadas. Pode
   rodar sozinha durante a reunião ou com o botão **Revisar com IA**.

Teste real dentro da extensão (Chromium, só processador) com um trecho de 22 s da Wikipédia Falada
(CC0) em três versões:

| Modelo | Áudio normal | Fala 1,5x mais rápida | Abafado com ruído |
|---|---|---|---|
| Rápido | 4,2 s, poucos erros | 4,3 s, poucos erros | 4,2 s, vários erros |
| Equilibrado | — | 13 s, quase perfeito | 12 s, quase perfeito |

## Recursos

**Durante a reunião (widget flutuante)**
- Transcrição ao vivo com nomes e cores por participante; arraste para reposicionar e minimize num botão.
- **Destaques com tags** (⭐ Importante, ✅ Decisão, 📌 Ação, ❓ Pergunta, ⚠️ Risco ou tags suas): passe o
  mouse numa fala ou use ⭐ para marcar o último bloco.
- **Notas com horário**, **capturas de tela** salvas na linha do tempo e **Pergunte à IA** com sugestões
  prontas ("Pontos principais", "Itens de ação", "3 perguntas", "O que perdi?").
- **Sua parcela de fala** em tempo real, comparada com a meta que você escolher.
- **Pausar/retomar**; **ocultar as legendas nativas** do Meet, sem parar a transcrição; botão para copiar o
  **aviso aos participantes**.
- Modo **"Perguntar antes de transcrever"** (sim desta vez / sempre / não). O que foi dito antes da
  resposta não se perde se você aceitar.

**Depois (painel lateral ou aba inteira)**
- Abas **Transcrição** (busca, filtro e renomear participante, notas e capturas na linha do tempo),
  **Destaques** agrupados por tag, **Notas** (Markdown com salvamento automático), **IA** (ata completa e
  conversas salvas) e **Análise** (duração, palavras, parcela de fala, palavras por minuto, perguntas, maior
  fala e gráfico de quem falou quando).
- **Reuniões anteriores com os mesmos participantes**, com um botão para a IA recapitular o que ficou
  pendente.
- **Busca em todas as transcrições**, filtros (plataforma, com ata, com destaques), **backup e importação**.
- Exportar: **cópia formatada** para colar no Google Docs, Notion ou e-mail, **PDF** com capturas, além de
  Markdown, TXT, SRT, WebVTT e JSON.
- **Ata automática** quando a reunião termina (opcional).
- A sessão continua de onde parou se a página da reunião for recarregada.
- Atalhos: <kbd>Alt+Shift+E</kbd> abre o Escribanote, <kbd>Alt+Shift+H</kbd> destaca, <kbd>Alt+Shift+S</kbd> faz uma
  captura e <kbd>Alt+Shift+P</kbd> pausa.

## Em relação à Tactiq

| | Tactiq | Escribanote (grátis) |
|---|---|---|
| Onde ficam os dados | Na nuvem da Tactiq, exige conta | **Só no seu computador**, sem conta |
| Limites no plano grátis | 10 transcrições e 5 créditos de IA por mês | **Sem limites**; a IA usa a sua chave |
| Telemetria | Sim | **Nenhuma** |
| Se a legenda do Meet falhar | Para de transcrever | **Plano B:** lê as legendas da tela |
| Reconhecimento | Legenda da plataforma | Legenda + Whisper local + revisão com glossário |
| Slack e apps fora do navegador | Não | **Sim**, pelo gravador do computador |
| Exportação | Docs/link (com conta) | Docs/Notion (cópia formatada), PDF, MD, TXT, **SRT, VTT**, JSON |
| Análise de fala | "Sua parcela" | Parcela, ritmo, perguntas, turnos e linha do tempo por pessoa |
| Compartilhar por link | Sim | No plano Pro (em desenvolvimento, veja `../docs/`) |

## Instalação

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha a pasta `extension/` deste repositório (ou a pasta
   `escribanote/` do zip baixado no site). Quem já usava o Escriba ou o Reunilo pode trocar a pasta sem perder nada: o ID
   da extensão é o mesmo.
3. Desative a Tactiq para as duas não transcreverem a mesma reunião.
4. Opcional: em **Ajustes**, informe seu nome na reunião (para "sua parcela de fala") e a chave da API do
   Claude (para a IA).

> **Capturas de tela:** o Chrome só libera a captura depois que você clica no ícone do Escribanote na aba da
> reunião ou usa <kbd>Alt+Shift+S</kbd>. Para capturar sempre pelo widget, use "Autorizar capturas pelo
> widget" em Ajustes.

## Como funciona

```
página da reunião (main world)        isolated world                     service worker            app
 src/main/meet.js  ─┐                  src/content/bridge.js               src/background.js         src/app/
 src/main/teams.js ─┼─ CustomEvent ─▶  (consentimento, pausa, lotes,  ─▶  (sessões, destaques,  ─▶  app.html (painel/aba)
 src/main/zoom.js  ─┘  "escribanote:evt"    legendas ocultas, plano B)         notas, capturas, IA,      print.html (PDF)
 (proto.js, core.js)                   src/content/widget.js (Shadow DOM)  atalhos, ata automática)
```

- **Meet:** escuta, sem nunca enviar nada, os `RTCDataChannel` `captions_v2`, `captions`,
  `collections` (nomes) e `meet_messages` (chat), decodificando protobuf com um leitor próprio.
- **Teams:** canal `main-channel` (JSON `recognitionResults`) + roster pelo WebSocket.
- **Zoom:** store Redux encontrada pela árvore React (`newLiveTranscription.newLTMessage`).
- `src/lib/`: modelo da transcrição (`transcript.js`), idioma (`lang.js`), estatísticas (`stats.js`),
  exportações (`format.js`), IA (`ai.js`, Claude via `fetch` com streaming e saída estruturada) e
  ajustes (`settings.js`).
- `src/asr/pipeline.js`: segmentação por voz e fila do Whisper (`vendor/transformers`, transformers.js 3.8.1,
  Apache-2.0), usada por `src/offscreen/` (áudio da aba da reunião, via `tabCapture`) e pelo gravador
  `src/app/gravar.*` (áudio do sistema via `getDisplayMedia` + microfone). A aba do gravador faz o papel da
  "aba da reunião" no service worker: fechar a aba encerra a sessão.

## Testes

```bash
npm test                                                     # 33 testes unitários
CHROME=/caminho/do/chrome node test/e2e-meet.mjs [pasta]     # ponta a ponta num Chrome real (+ screenshots)
CHROME=/caminho/do/chrome node test/e2e-asr.mjs audio.f32    # Whisper real na extensão (PCM float32 16 kHz)
CHROME=/caminho/do/chrome node test/e2e-backup.mjs [pasta]    # backup na pasta, restauração e ajustes sincronizados
CHROME=/caminho/do/chrome node test/e2e-account.mjs [pasta]   # conta Pro: conectar, sincronizar, conflito, IA da conta (precisa do Postgres de teste, ver ../server)
PULSE_SERVER=unix:/nonexistent CHROME=/caminho/do/chrome node test/e2e-recorder.mjs sistema.wav mic.wav [pasta]  # gravador do computador (no WSL, sem o servidor de som travar o AudioContext)
```

O teste ponta a ponta carrega a extensão, simula reuniões do Meet com um par WebRTC local enviando
pacotes no formato real e verifica:

- o widget;
- destacar, adicionar nota e pausar/retomar;
- as legendas ocultas;
- o modo "perguntar";
- o app (transcrição, destaques, análise, IA e lista);
- a busca global e a exportação;
- o layout em largura de painel lateral;
- a revisão por IA com glossário e o chat (com a API do Claude simulada);
- um segmento do Whisper assumindo o falante certo;
- o aviso de legenda em idioma errado.

## Limitações conhecidas

- Os formatos internos do Meet, do Teams e do Zoom não são documentados e podem mudar. O Meet tem o
  plano B por DOM; Teams e Zoom não.
- Só o Meet tem teste ponta a ponta (simulado). Ainda não foram testados de verdade:
  - Teams e Zoom;
  - a captura de áudio de uma aba real (`tabCapture`);
  - o gravador com o áudio do sistema de verdade no Windows (o teste simula o compartilhamento de tela);
  - capturas de tela;
  - chamadas reais à API do Claude.
- No modo de alta precisão, o eco do alto-falante pode entrar pelo microfone. Prefira fone de ouvido
  ao ligar "Incluir o meu microfone".
- A IA usa o modelo escolhido em Ajustes (padrão: `claude-opus-5-5`) e é cobrada na sua conta da API.
- A chave de API fica em `chrome.storage.local`, sem criptografia, como em outras extensões.
