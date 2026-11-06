# Changelog do Escribanote

Uma entrada por versão, a mais nova no topo. Detalhes técnicos de cada mudança ficam no README.

## 0.9.58 beta — 2026-11-06
- Pergunte à IA: cada resposta tem "Copiar resposta" e "Copiar com a pergunta" (formatado para Docs, Notion ou e-mail, e texto puro); conversas com mais de uma pergunta têm "Copiar a conversa inteira".
- Exportar › "Incluir na exportação": escolha se entram o chat da reunião, as notas, os destaques, os capítulos e as perguntas e respostas da IA, com a quantidade de cada um nesta reunião. A escolha fica lembrada. Vale para copiar, PDF, Markdown e texto; o padrão continua como antes (tudo, menos as conversas com a IA).

## 0.9.57 beta — 2026-11-06
- Perguntas à IA de até 10.000 caracteres (antes 2.000), para roteiros detalhados de análise: nos modelos de perguntas, na caixa de pergunta, no widget e no app web. A resposta pode ir a 16 mil tokens (antes ~4 mil no Pro e ~8 mil com chave própria), então estudos longos não saem cortados, e a IA segue por completo o roteiro e o formato pedidos.
- No Pro, pergunta com mais de 2.000 caracteres custa 2 créditos (as curtas continuam custando 1); o app web mostra o custo enquanto você escreve.
- Na conversa, perguntas longas aparecem recolhidas ("ver a pergunta inteira"); a caixa do modelo cresce até cerca de 10 linhas e rola.
- Contagem de caracteres também na caixa de pergunta, nas notas da reunião, no editor da ata, no texto do modelo de ata, no glossário, na mensagem de aviso aos participantes, em "Seu nome nas reuniões" e nas janelinhas de nome/texto.

## 0.9.56 beta — 2026-11-06
- Contagem de caracteres (ex.: 17/60) nos modelos de perguntas — nome curto e pergunta, também no rascunho de modelo novo —, sempre visível no canto do campo; fica laranja perto do limite e vermelha no limite.
- Nos outros campos com limite (título da reunião, nova nota, instruções e rótulo da versão da ata; em Ajustes, contexto da equipe, instruções padrão da ata, nome do modelo de ata e nome da tag), a contagem aparece num selo sob o campo enquanto ele é editado.

## 0.9.55 beta — 2026-11-05
- Modelos de perguntas (aba IA) revistos: o alfinete muda na hora ao fixar ou desafixar (antes só atualizava depois de clicar em outro lugar) e o desafixado fica visivelmente diferente (alfinete inclinado e apagado, cartão tracejado).
- "+ Novo modelo" abre um rascunho no topo da lista, com nome e pergunta em branco; ele só é salvo (e vira atalho) com os dois preenchidos. Enter salva, Esc cancela. Os "Nova pergunta" que a versão anterior criava a cada clique somem sozinhos.
- Setas ↑ ↓ ordenam os modelos e os atalhos; apagar um modelo ou restaurar os padrões pode ser desfeito pelo aviso; sem nenhum modelo fixado, um atalho leva à lista.
- Editar um modelo e logo clicar no alfinete não desfaz mais a edição.

## 0.9.54 beta — 2026-11-05
- Capturas de tela só do conteúdo compartilhado (Ajustes › Capturas de tela e atalhos › "O que capturar"): salva só a apresentação ou a tela em destaque, na resolução original do vídeo, sem a interface da reunião. Sem apresentação na tela, salva a aba inteira. Vale para o botão do widget e para Alt+Shift+S; o padrão continua a aba inteira.

## 0.9.53 beta — 2026-11-05
- Webhook pós-reunião (Ajustes › Avançadas › Integrações): ao terminar, a reunião vai em JSON (título, plataforma, horários, participantes, ata, perguntas automáticas, capítulos, transcrição e Markdown) para o endereço escolhido — Zapier, Make, n8n ou servidor próprio levam ao Notion, Google Docs, CRM… Botão "Enviar teste". A permissão é pedida só para aquele site; áudio e capturas não vão.

## 0.9.52 beta — 2026-11-05
- Perguntas sobre várias reuniões: na aba IA, "Perguntar sobre" escolhe entre só esta reunião, esta + as anteriores com os mesmos participantes, ou esta + as 5 últimas. A IA diz de qual reunião (título e data) vem cada informação. Funciona com a chave própria e com o Pro.

## 0.9.51 beta — 2026-11-05
- Alta precisão "Automático": escolhe o modelo pelo computador (placa de vídeo ou processador forte → equilibrado; senão, rápido) e, na bateria abaixo de 30% sem carregar, usa o rápido, que gasta menos. A escolha fica registrada no Diagnóstico.

## 0.9.50 beta — 2026-11-05
- Perfis de voz (Pro, opcional, desligado por padrão): a impressão de voz de quem tem nome na reunião fica guardada só neste computador e a pessoa é reconhecida pela voz desde a primeira fala nas reuniões seguintes, mesmo sem legenda. Lista em Ajustes › Avançadas › Reconhecimento, com apagar por pessoa ou todas. Nunca vai para backup, conta ou sincronização (dado biométrico, LGPD).
- Dois perfis salvos nunca são juntados entre si; numa junção, o perfil com nome é o que fica.
- O selo "Pro" dentro das opções não aparece mais como um segundo interruptor.

## 0.9.49 beta — 2026-11-05
- Localizar e substituir: botão "Substituir" ao lado da busca troca uma palavra ou nome em toda a transcrição (palavra inteira e maiúsculas opcionais), com a contagem de ocorrências e um único Ctrl+Z para desfazer.
- O horário citado pela IA limpa a busca antes de levar ao trecho (um filtro ativo escondia a fala).

## 0.9.48 beta — 2026-11-05
- Consentimento: o megafone do widget pisca até o aviso de transcrição ser enviado na reunião; nova opção (Ajustes › Transcrição) para enviar o aviso sozinho no chat assim que a transcrição começa.
- Aviso padrão mais claro: transcrição no navegador, sem bot e sem gravar o vídeo, com convite para quem preferir que não.
- Site: página de privacidade explica sem bot, aviso em um clique, aviso automático, pausa e base legal sugerida (LGPD).

## 0.9.47 beta — 2026-11-05
- Ata e respostas da IA citam o horário de cada ponto (`[00:12:31]`); no app, o horário é um link que leva ao trecho da transcrição. Quando algo não foi dito, a IA responde "não consta na transcrição" em vez de supor. (Atas em modelo institucional não levam horários.)
- A junção final das vozes (vozes com pouquíssima fala vão para a mais parecida) passa a valer também quando chega depois de a reunião encerrar.

## 0.9.46 beta — 2026-11-05
- A mesma voz não vira dois falantes: centroide ponderado pelos segundos de fala, junção ao vivo de vozes parecidas e absorção das vozes mínimas no fim (`src/asr/voicebook.js`).
- "Manter separados" é respeitado pela junção automática por nome.
- Abrir a reunião ao vivo não grava mais a sessão (podia competir com as falas chegando).
- Modelos de perguntas: fixar e desafixar (só os fixados viram atalhos); ações em ícones com dica.

## 0.9.45 beta — 2026-11-05
- Modelos de perguntas na aba IA, com execução automática ao fim da reunião (1 crédito do Pro por pergunta) e pílula AUTO.
- Análise com painéis recolhíveis: "Quem falou e quanto" e "Linha do tempo: quem falou quando".
- Mesmo nome = mesmo participante (reconexões e "Apresentação de …"); identificadores `keep_…` não viram nome.
- Arquivo exportado: `Nome - Meio - AAAA-MM-DD HHhMM.ext`.
- Uso pessoal ou institucional no primeiro passo do assistente; Ajustes básicos à vista e avançados recolhidos.

## 0.9.44 beta
- Extensão atualizada ou recarregada com o Meet aberto não gera mais "Extension context invalidated".
- A fala que aparece na tela no instante em que as legendas do Meet ficam ilegíveis não se perde mais.

## 0.9.43 beta
- Marcações da fala num só botão Marcar com menu; a barra cabe numa linha no painel lateral.

## 0.9.42 beta
- No painel lateral, a barra de ações da fala aparece embaixo do texto.

## 0.9.41 beta
- Legendas do Meet em formato novo não se perdem mais (leitura flexível, plano B pela tela, amostras no diagnóstico).

## 0.9.40 beta
- Abas e ações da ata grudam nas bordas da janela ao rolar.

## 0.9.39 beta
- Tema claro, escuro ou automático.

## 0.9.38 beta
- Leitura limpa, correção de nomes pelo glossário, ícones próprios e logotipo novo.

## 0.9.37 beta
- Renumeração para beta 0.9.x, correção à mão marcada nas palavras, hora do relógio nas falas.
