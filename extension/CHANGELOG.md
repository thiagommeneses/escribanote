# Changelog do Escribanote

Uma entrada por versão, a mais nova no topo. Detalhes técnicos de cada mudança ficam no README.

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
