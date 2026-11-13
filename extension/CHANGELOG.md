# Changelog do Escribanote

Uma entrada por versão, a mais nova no topo. Detalhes técnicos de cada mudança ficam no README.

## 0.9.79 beta — 2026-11-13
- **Slides a partir da reunião**: nova aba **Slides** (na extensão e no app web). A IA monta a apresentação com o que foi dito e, se houver, com as capturas de tela da reunião (ela escolhe as que mostram gráficos, telas e slides, nunca rostos). Escolha o tipo (resumo executivo, aula ou treinamento, status de projeto ou reunião comercial), o tamanho, o estilo (moderno, clássico ou minimalista), as cores e o tema claro ou escuro, e diga o foco em instruções opcionais.
- **Cada slide aponta o momento da reunião** de onde saiu: clique no horário e a transcrição vai direto à fala. Todos os slides vêm com **notas do apresentador** tiradas do que foi falado.
- **Ver, editar e apresentar**: troque títulos, tópicos, números, citações e notas, mude a ordem, duplique ou apague slides e troque estilo, cores e tema a qualquer momento, sem gastar crédito. **Apresentar** abre em tela cheia (setas, espaço, Esc).
- **Baixar .pptx** (abre no PowerPoint, no Keynote e no Google Slides, editável e com as notas) ou **PDF** (um slide por página).
- Custa 1 crédito no Escribanote Pro, ou usa a sua própria chave de API.

## 0.9.78 beta — 2026-11-12
- **Reels e vídeos em loop param sozinhos**: quando o vídeo recomeça, o Escribanote percebe que as falas estão se repetindo, guarda só uma volta e encerra a transcrição, com o aviso "O vídeo recomeçou". Cole o link do reel, clique no ícone e o texto fica pronto sem precisar apertar Parar.
- **Aviso de vídeo mudo**: em "Transcrever esta aba" e no link colado, se nenhum som chegar da aba por 10 segundos, o painel avisa para clicar no vídeo e ativar o som ou dar play (o Instagram costuma abrir o reel mudo). O aviso some quando o som volta. Em reuniões, onde silêncio é normal, não aparece.

## 0.9.77 beta — 2026-11-12
- Corrigido: **Transcrever esta aba** falhava com "O Chrome só libera o áudio depois que você clica no ícone…" quando o painel lateral tinha sido aberto em outra aba (ele continua aberto ao trocar de aba, mas o navegador só libera o som da aba em que o ícone foi clicado). Agora, sem esse clique, o painel avisa "Falta um clique para liberar o som" e a transcrição começa sozinha assim que você clica no ícone do Escribanote nessa aba (ou Alt+Shift+E).
- Clicar no ícone com o painel aberto não o fecha mais, e o clique sempre libera o som daquela aba (Chrome e Edge).
- A tentativa que falha não deixa mais uma sessão vazia na lista, e o contador de notificações "(9+)" não entra no nome da sessão.

## 0.9.76 beta — 2026-11-12
- **Fim do teste grátis sem erro de sincronização**: vencido o prazo, a extensão para de enviar reuniões sozinha. Se a conta recusar por falta de plano, isso não aparece como erro; as reuniões ficam na fila e vão quando o Pro voltar.
- Servidor: e-mail de aviso algumas horas antes do fim do teste (um só), e respostas no thread do Slack só com o Pro ativo.
- Site: página de **Termos de uso** (teste, assinatura, garantia de 7 dias, créditos, cancelamento) e a linha do Slack na tabela Grátis × Pro.

## 0.9.75 beta — 2026-11-12
- **Lista de reuniões mais fácil de ler**: cada reunião virou um cartão, com uma faixa na cor da plataforma (Meet verde, Teams roxo, Zoom azul, Slack magenta, página da web laranja, arquivo e computador cinza). As datas ganharam uma linha divisória, e as pastas e as Fixadas aparecem em blocos próprios. As iniciais dos participantes não se sobrepõem mais.

## 0.9.74 beta — 2026-11-12
- **Teste grátis do Pro por 48 horas**: sem cartão e sem cobrança no fim, com tudo do Pro liberado e 5 créditos de IA. Começa em Conta, no app web, e vale uma vez por e-mail. Quando o prazo acaba, a extensão volta para o grátis sozinha, mesmo sem consultar a conta.
- **Garantia de 7 dias** na assinatura do Pro: desistiu, devolvemos tudo.
- Página do Pro: teste grátis, garantia e "Em breve: plano Equipe" na tabela Grátis × Pro.
- Política de privacidade atualizada: senha opcional, teste grátis e o Groq como subprocessador da transcrição no servidor.

## 0.9.73 beta — 2026-11-12
- **Datas dentro das pastas**: as reuniões de cada pasta aparecem separadas por dia (Hoje, Ontem, terça-feira, 10 de novembro…), como na lista.
- **Parar a resposta da IA**: enquanto a IA responde, o botão Enviar vira **Parar**. O que já foi escrito fica na conversa, com a nota "Resposta interrompida por você".
- **Pro: IA em paralelo**: com o Escribanote Pro, dá para perguntar enquanto a ata é gerada (e durante a revisão). Cada tarefa tem o seu Cancelar/Parar. Sem o Pro, continua uma tarefa de IA por vez, com um aviso.

## 0.9.72 beta — 2026-11-12
- **Colar o link de um vídeo**: no painel, "Tem o link de um vídeo?" abre o link (YouTube, Instagram, aula, podcast) numa aba nova. Falta só um clique no ícone do Escribanote nessa aba (ou Alt+Shift+E), que o Chrome exige para liberar o som, e a transcrição começa sozinha, sem precisar apertar mais nada. O painel avisa enquanto espera o clique; fechar a aba desiste.
- O nome da sessão passa a ser o título do vídeo assim que a página termina de carregar.

## 0.9.71 beta — 2026-11-12
- **Transcrever no servidor (Pro)**: trechos de silêncio não viram mais falas inventadas ("Thank you.", "Legendas pela comunidade…"). O nível de cada fala é medido no próprio áudio e falas em silêncio são descartadas, como já acontecia no Whisper local. O horário final de uma fala também não passa mais do fim do pedaço.

## 0.9.70 beta — 2026-11-10
- **Transcrever esta aba**: em qualquer página com som (YouTube, Instagram, aulas, podcasts), abra o painel do Escribanote pelo ícone e clique no botão. O som da aba é transcrito com o Whisper neste computador enquanto toca, sem microfone, numa sessão "Página da web" com o nome do vídeo. **Parar** encerra; fechar a aba também.
- **Transcrever no servidor (Pro)**: ao importar um arquivo, a opção "No servidor (Pro, rápido)" manda o áudio para a sua conta e transcreve com o Whisper large em poucos minutos, mesmo arquivos de horas. Custa 1 crédito por hora de áudio, arredondado para cima e mostrado antes de começar. Se nada for transcrito, os créditos voltam. Também tem progresso, Cancelar e Continuar de onde parou.
- O arquivo continua sendo lido no seu computador. Para o servidor vão só pedaços de 10 min de áudio.

## 0.9.69 beta — 2026-11-10
- **Transcrever arquivo** aguenta áudios e vídeos longos (1, 2, 3 h): o arquivo é lido aos poucos, em trechos de 30 s, sem carregar tudo na memória, e o trabalho é contado em partes de 30 min. Antes, um arquivo longo podia travar o navegador. Formatos: mp3, wav, ogg (Opus/Vorbis), m4a, mp4, mov e webm, até 2 GB.
- Antes de começar, um aviso com a duração do áudio, quantas partes ele terá e que pode demorar.
- Durante a transcrição, uma barra acima do texto mostra a porcentagem, a parte atual ("parte 2 de 6"), os minutos já transcritos e até onde o arquivo foi lido, o tempo decorrido e quanto falta. Fechar e reabrir a tela não perde o acompanhamento.
- Botão **Cancelar**. Ao fim de cada parte o ponto é salvo: se você cancelar, se der erro ou se o navegador fechar, a reunião mostra **Continuar de onde parou**, sem refazer nem repetir o que já foi transcrito (ou **Recomeçar do zero**).

## 0.9.68 beta — 2026-11-07
- Corrigido: ao pedir arquivos (código, .md, um pacote .zip), a IA dizia que tinha gerado e anexado arquivos que não existiam, com nomes, pastas e até "conferi o .zip". O chat só recebe texto; agora a IA sabe disso, escreve o conteúdo completo de cada arquivo num bloco de código com o nome dele e nunca mais promete anexos, pastas ou links.
- Blocos de código nas respostas aparecem formatados, com o nome do arquivo no topo e um botão **Baixar**. Quando a resposta tem dois ou mais arquivos, **Baixar os arquivos (.zip)** junta todos, mantendo as pastas (ex.: `mt5/`, `profit/`).
- PDF e Word continuam pelo botão **Exportar** da resposta.
- Corrigido: uma resposta longa que já estava sendo escrita sumia inteira se a conexão caísse ou se a continuação automática falhasse (por exemplo, quando a conversa, as capturas e o texto parcial passavam do limite do modelo). Agora o que já veio fica salvo, com um aviso do motivo no fim, e é só pedir "continue de onde parou". Os erros também passam a aparecer no fim da conversa, sem precisar rolar.

## 0.9.67 beta — 2026-11-06
- Corrigido: respostas muito longas (roteiros detalhados) paravam no meio de uma frase sem aviso, porque a IA chegava ao limite de tamanho. O limite das perguntas dobrou (32 mil tokens) e, se ainda assim a resposta for cortada, a IA continua sozinha do ponto exato onde parou, até duas vezes, e o texto sai emendado. Se mesmo assim faltar, a resposta termina com um aviso claro. Vale também para a ata, com a sua chave e no Pro, sem custo extra de créditos.
- Pergunte à IA: botão **Exportar** em cada resposta, com "Só a resposta", "Pergunta e resposta" ou "Conversa inteira", em Markdown, Word, texto ou PDF.
- **Excluir a conversa**: ícone de lixeira ao lado do seletor de conversas (e no botão direito), com "Desfazer" por alguns segundos. O ícone vizinho exporta a conversa inteira.
- **Editar e reenviar** a última pergunta, e **Gerar de novo** a última resposta, como no Claude e no ChatGPT: a resposta anterior é substituída e a pergunta fica marcada como "editada". Se a nova tentativa falhar, a conversa volta como estava. Também pelo botão direito.
- Conversas excluídas ou editadas não voltam ao sincronizar com a conta Pro.

## 0.9.66 beta — 2026-11-06
- Aparência: dois estilos novos, escolhidos por miniaturas com as cores reais. No claro, **Papel** (off-white quente com tons pastel, como o site). No escuro, **Editor** (grafite no estilo VS Code / Cursor, cantos retos e horários em fonte monoespaçada). No modo Automático, cada lado usa o estilo escolhido para ele (por exemplo, Papel de dia e Editor à noite) e troca junto com o sistema.
- O widget dentro da reunião agora segue o tema (claro, Papel, escuro ou Editor), com as cores dos falantes e das marcações ajustadas a cada fundo. Quem preferir o widget sempre escuro, como antes, desliga a opção em Ajustes › Aparência.
- Caixas de seleção e controles nativos na cor do tema.
- Corrigido: a faixa "Solte aqui para fixar no topo" podia ficar presa na lista depois de um arraste muito curto.

## 0.9.65 beta — 2026-11-06
- Fixar no topo: reuniões fixadas ficam numa seção "Fixadas" no alto da lista (botão direito › Fixar no topo, ou arraste o cartão para lá).
- Pastas: "Nova pasta" na lista; o nome é editado no próprio lugar. Arraste os cartões para uma pasta, para "Fixadas" ou de volta para a lista. As pastas recolhem e abrem com um clique, mostram quantas reuniões têm e podem ser renomeadas, reordenadas e apagadas (apagar uma pasta não apaga as reuniões). Elas acompanham os ajustes sincronizados e o backup exportado.
- Menu do botão direito conforme o lugar: no cartão da reunião (abrir, abrir em nova aba, renomear, fixar, mover para pasta, tirar da pasta, apagar); na pasta (recolher, renomear, mover para cima/baixo, nova pasta, apagar); na área da lista (nova pasta, recolher/abrir todas); numa fala da transcrição (copiar, marcar, nota, corrigir, dividir, mover para outro falante, apagar); nas mensagens da IA (copiar resposta, copiar com a pergunta). Funciona também pelo teclado (tecla de menu ou Shift+F10) e navega com as setas.
- Em áreas vazias o menu do navegador não aparece mais. Ele continua onde serve: campos de texto, texto selecionado, links, imagens e sobre o próprio texto.

## 0.9.64 beta — 2026-11-06
- Corrigido "Pensando…" que nunca terminava em perguntas longas (roteiros grandes com capturas de tela e pesquisa na web): enquanto a IA raciocinava ou pesquisava sem mandar texto, o Chrome encerrava o processo da extensão em segundo plano e a tela não percebia. Agora a extensão manda um sinal de vida a cada 15 segundos e a resposta continua normalmente.
- Se a conexão ainda assim cair, ou a IA ficar 1 minuto sem dar sinal, a espera termina com uma mensagem clara e a pergunta volta para a caixa, para tentar de novo sem redigitar. Vale para perguntas, ata, revisão e o widget da reunião.
- A espera mostra a etapa real: "Analisando…", "Pesquisando na web…", "Lendo os resultados da pesquisa…" (extensão, ata e app web).
- Uma resposta da API que fica 2 minutos sem enviar nada é dada como perdida, com aviso, em vez de esperar para sempre.

## 0.9.63 beta — 2026-11-06
- Ata: em vez do texto aparecendo aos pedaços, um cartão de espera mostra a etapa ("Lendo a transcrição…", depois "Escrevendo a ata…"), o tempo decorrido e quantas palavras já foram escritas, sobre um esqueleto animado da ata. "Mostrar prévia" abre o texto parcial para quem quiser acompanhar; no fim a ata aparece de uma vez, já formatada. Vale na extensão e no app web.
- Pergunte à IA: o "Pensando…" ganhou indicador animado e tempo decorrido (extensão e app web); no widget da reunião, reticências animadas. Quando a resposta começa, ela segue aparecendo ao vivo, como num chat.
- Revisão da transcrição e importação de modelo de ata: indicador animado com o tempo decorrido junto do progresso.

## 0.9.62 beta — 2026-11-06
- Corrigida a causa real de "Dividir em capítulos" voltar vazio com a sua chave (a 0.9.61 não resolvia): desde a 0.9.60, as chamadas sem texto ao vivo (capítulos, revisão da transcrição e modelo a partir de PDF) descartavam o texto recebido. Perguntas e ata não eram afetadas.
- Se os capítulos ainda vierem sem texto, a extensão tenta uma vez sem o formato JSON rígido; e o erro de resposta vazia agora mostra o motivo, para facilitar o diagnóstico.
- O mesmo descuido, mais antigo e raro, foi corrigido no streaming da conta Pro e no app web.

## 0.9.61 beta — 2026-11-06
- Corrigido "Dividir em capítulos" respondendo "A resposta veio vazia" com a sua chave: o modelo (Opus 5.5 por padrão) raciocina antes de responder e gastava todo o limite de 4.000 tokens nisso, sem sobrar o texto. O limite subiu para 16.000 nos capítulos, no modelo a partir de PDF e na revisão (também no servidor Pro).
- Quando a resposta ainda assim vier vazia por falta de tokens, o erro diz isso e sugere tentar de novo ou escolher um modelo mais rápido.

## 0.9.60 beta — 2026-11-06
- A IA lê as capturas de tela: na aba IA, "Enviar as capturas de tela" manda até 20 capturas da reunião (espaçadas, cada uma com o horário) junto com a pergunta, para ler gráficos, preços e slides que a fala não diz. A IA cita o horário da captura e separa o que viu na tela do que foi dito.
- Captura automática do conteúdo compartilhado (Ajustes › Capturas de tela e atalhos): a cada 1, 2, 5 ou 10 minutos durante a reunião, guarda o quadro da apresentação ou tela compartilhada, só quando ele muda (funciona com a aba da reunião em segundo plano). Aparecem menores na linha do tempo, marcadas como "automática".
- Pesquisa na web opcional (aba IA › "Pesquisar na web o contexto do dia"): a IA busca notícias, indicadores e agenda da data da reunião quando a pergunta pede algo que não foi dito, e lista as fontes no fim da resposta. Com a sua chave, a pesquisa precisa estar liberada na organização da Anthropic (US$ 10 a cada 1.000 buscas, até 5 por pergunta).
- Capturas e pesquisa na web valem para toda pergunta da reunião, inclusive as automáticas e as do widget, e contam como pergunta pesada (modelo mais forte; 2 créditos no Pro).
- Ajustes › Vocabulário: botão "+ Termos do mercado financeiro" (WIN, WDO, BOVA11, VWAP, Payroll, Copom, travas…), sem duplicar os que já existem.
- Aba IA: quando a transcrição longa ainda não foi revisada, um aviso sugere revisar antes de análises longas, com o botão "Revisar agora".

## 0.9.59 beta — 2026-11-06
- A IA não para mais no meio de um roteiro: quando parte do pedido não está na transcrição, ela faz todo o resto, marca "não informado" no que falta e deixa as limitações num bloco curto no fim (antes podia responder só com a lista do que faltava e pedir permissão para continuar).
- Perguntas longas (mais de 2.000 caracteres) ou com material de apoio usam um modelo mais forte e raciocinam mais: com a sua chave, o Sonnet 5.5 por padrão (Ajustes › IA › "Perguntas longas ou com material de apoio"; nunca um modelo mais fraco que o escolhido); no Pro, o modelo forte, por 2 créditos.
- Material de apoio na aba IA: anexe cotações (CSV), notícias (PDF), calendário econômico, prints de gráficos (PNG/JPEG) ou cole um texto. Vai junto em toda pergunta daquela reunião, inclusive pelo widget e nas perguntas automáticas, e a IA diz o que veio dele e o que veio da transcrição. Até 10 itens, 5 MB por arquivo e 8 MB no total; dá para arrastar os arquivos para a caixa. Os anexos ficam só neste computador e não entram no backup.

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
