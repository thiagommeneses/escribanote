# Ficha do Escribanote na Chrome Web Store

Tudo o que o painel do desenvolvedor pede, na ordem das abas. Imagens nesta pasta (`gerar.mjs` refaz).
Pacote: `python3 scripts/pacote-loja.py` (atualização) ou com `--chave ../escribanote-chave-privada.pem` (só no primeiro envio, mantém o ID `ohbnmfogdcbgegnpcaphidkjinplednd`).

## Pacote

- Primeiro envio: `loja/escribanote-loja-<versão>-com-chave.zip` (leva `key.pem`, a loja usa essa chave e o ID fica igual ao da instalação pelo site).
- Depois de enviar, confira o ID mostrado no painel. Se não for `ohbnmfogdcbgegnpcaphidkjinplednd`, a loja ignorou a chave: some o ID novo em `EXTENSION_IDS` no `pro.env` do servidor e em `EXTENSION_IDS` de `site/app/app.js`, e publique antes de enviar para revisão.
- Atualizações: `loja/escribanote-loja-<versão>.zip` (sem chave), com `version` maior que a anterior.

## Ficha da loja

**Nome:** Escribanote — Transcrição de Reuniões

**Resumo (até 132 caracteres, vem do manifest):**
Transcreve Google Meet, Teams, Zoom e Slack com privacidade: Whisper local, ata e slides com IA, destaques, notas e busca.

**Descrição:**

O Escribanote transcreve suas reuniões do Google Meet, Microsoft Teams, Zoom e huddles do Slack enquanto elas acontecem e guarda tudo no seu computador.

O que ele faz:
• Transcrição ao vivo, com quem falou e quando, a partir das legendas da reunião ou do áudio (Whisper rodando no seu próprio computador, sem enviar o áudio a ninguém).
• Widget discreto dentro da reunião: destaque o último trecho, anote, tire captura de tela, pause e pergunte à IA sem sair da chamada.
• Ata pronta em segundos, com decisões e ações (responsável e prazo), no seu modelo. Exporte em PDF, Word, Markdown ou texto.
• Slides a partir da reunião: a IA monta a apresentação em 8 estilos, com notas do apresentador e .pptx editável. Cada slide aponta o momento da fala.
• Pergunte à IA sobre a reunião: pontos principais, itens de ação, o que você perdeu.
• Análise de fala, destaques por tipo (decisão, ação, risco), busca em todas as reuniões e pastas.
• Transcreva também uma aba (vídeo, aula, webinar) ou um arquivo de áudio e vídeo.

Privacidade em primeiro lugar: a transcrição local é grátis e fica só no seu navegador. Os recursos de IA usam a sua própria chave da API da Anthropic ou o Escribanote Pro (opcional, com conta e créditos, reuniões guardadas criptografadas). Política de privacidade: https://escribanote.com/privacidade.html

Avise os participantes: o widget tem um botão que manda no chat da reunião o aviso de que ela está sendo transcrita.

**Categoria:** Produtividade › Comunicação (alternativa: Ferramentas)
**Idioma:** Português (Brasil)

**Imagens:**
- Ícone 128×128: `extension/icons/icon128.png`
- Capturas 1280×800: `loja-1-transcricao.png`, `loja-2-ata.png`, `loja-3-slides.png`, `loja-4-ia.png`, `loja-5-analise.png`
- Bloco promocional pequeno 440×280: `loja-bloco-pequeno.png`
- Bloco promocional grande 1400×560 (opcional): `loja-bloco-grande.png`

**Site oficial:** https://escribanote.com
**Suporte:** https://escribanote.com/contato/

## Privacidade (aba "Práticas de privacidade")

**Finalidade única:**
Transcrever e organizar reuniões online (Google Meet, Teams, Zoom e huddles do Slack) e, a pedido do usuário, outras abas e arquivos de áudio: transcrição, destaques, notas, ata, slides e perguntas à IA sobre o que foi dito.

**Justificativas das permissões:**

- **storage:** guarda as transcrições, notas, destaques e os ajustes no próprio navegador.
- **unlimitedStorage:** reuniões longas, capturas de tela e o áudio opcional passam do limite padrão; sem isso a transcrição seria cortada.
- **sidePanel:** o painel do Escribanote (lista de reuniões, transcrição, ata, IA) abre no painel lateral, ao lado da reunião.
- **activeTab:** ao clicar no ícone ou usar o atalho, libera a aba atual para transcrever o som dela ("Transcrever esta aba") e para tirar captura de tela da reunião.
- **offscreen:** o reconhecimento de fala (Whisper) e a gravação do áudio da aba rodam num documento fora da tela, porque o service worker não tem acesso a áudio nem a WebAssembly com threads.
- **tabCapture:** captura o áudio da aba da reunião ou do vídeo que o usuário mandou transcrever, para o Whisper local. Só começa por ação do usuário.
- **downloads:** salva as exportações (PDF, Word, .pptx, texto) e o backup automático das reuniões na pasta Downloads.
- **downloads.ui:** esconde a barra de downloads durante o backup automático, que roda sozinho ao fim de cada reunião, para não interromper o usuário.
- **nativeMessaging (opcional):** só se o usuário instalar o "Ajudante de áudio" do Windows (programa nosso, opcional) para gravar o som do computador sem o seletor de compartilhar tela.
- **Acesso a https://api.anthropic.com (opcional):** pedido só quando o usuário coloca a própria chave da API da Anthropic, para a ata, os slides e as perguntas à IA irem direto do navegador para a Anthropic.
- **Acesso a todos os sites (opcional):** pedido só quando o usuário liga "capturas de tela pelo widget" (a captura da aba precisa desse acesso) ou cadastra um webhook próprio para receber a ata; neste caso é pedido só o endereço do webhook.
- **Scripts nas páginas do Meet, Teams, Zoom e Slack:** leem as legendas e quem está falando para montar a transcrição, e mostram o widget dentro da reunião.

**Código remoto:** Não. Todo o código vai no pacote (inclusive o ONNX Runtime/transformers.js em `vendor/`). Os modelos de reconhecimento de fala (pesos do Whisper e da separação de falantes, do Hugging Face) são baixados como dados na primeira vez e executados pelo código do pacote.

**Uso de dados (marque):**
- Informações de identificação pessoal: **sim**, só para quem cria a conta do Pro (e-mail).
- Informações de autenticação: **sim**, só no Pro (sessão da conta).
- Comunicações pessoais: **sim** (o conteúdo das reuniões transcritas).
- Conteúdo do site: **sim** (legendas e nomes dos participantes na página da reunião).
- Informações financeiras, de saúde, localização, histórico da web, atividade do usuário: **não**.

**Certificações (marque as três):** não vendo nem transfiro dados a terceiros fora dos usos aprovados; não uso nem transfiro dados para fins não relacionados à finalidade única; não uso nem transfiro dados para avaliar crédito ou conceder empréstimos.

**Política de privacidade:** https://escribanote.com/privacidade.html

## Distribuição

- Visibilidade: Pública (ou "Não listada" para testar com poucos usuários primeiro).
- Regiões: todas.
- Pagamento: grátis na loja. O Pro é assinado no site (Stripe), fora da loja.

## Instruções para o revisor (campo "Test instructions")

The extension works on Google Meet, Microsoft Teams, Zoom (web client) and Slack huddles. To test:
1. Join any Google Meet call (you can start one alone at meet.google.com). The Escribanote widget appears in the bottom-right corner and transcription starts from the meeting captions (the extension turns captions on automatically).
2. Speak a few sentences; the text shows up in the widget. Click the extension icon (or Alt+Shift+E) to open the side panel with the full transcript.
3. To test without a meeting: open any YouTube video, click the extension icon and choose "Transcrever esta aba" (transcribe this tab). The first run downloads the local Whisper model (~80 MB).
4. AI features (minutes, slides, questions) need either the user's own Anthropic API key (Settings › IA) or an Escribanote Pro account; core transcription works without any account.
The UI is in Portuguese (Brazil).
