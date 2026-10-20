# Reunilo

**Transcrição de reuniões local e privada** para Google Meet, Microsoft Teams, Zoom e huddles do Slack,
com reconhecimento de alta precisão (Whisper rodando no seu computador), revisão por IA com glossário,
destaques, notas, análise de fala e ata.

O Reunilo é uma extensão do Chrome. Na versão grátis, tudo fica no seu computador: sem conta, sem
servidor, sem telemetria e sem limite de reuniões. Até a versão 2.3 o projeto se chamava **Escriba**.

- **Site:** https://reunilo.meneseslabs.com.br
- **Versão atual:** 2.4.0

## O que tem aqui

| Pasta | O que é |
| --- | --- |
| [`extension/`](extension/) | A extensão do Chrome (Manifest V3): código, testes e [documentação completa](extension/README.md) |
| [`site/`](site/) | O site de divulgação (HTML/CSS/JS estático) e o servidor do formulário de contato |
| [`docs/`](docs/) | Documentos de design, como o [TDD do Reunilo Pro](docs/TDD-reunilo-pro.md) |

## Recursos

- **Transcrição ao vivo** no Meet, Teams e Zoom pelo navegador, com nomes e cores por participante.
- **Gravador do computador** para huddles do Slack e qualquer app que toque som (Windows e ChromeOS).
- **Três camadas de reconhecimento:** legendas da plataforma, Whisper local (WebGPU ou processador) e
  revisão por IA com glossário de nomes e siglas.
- **Widget na reunião:** destaques com tags, notas com horário, capturas de tela, "Pergunte à IA" e a
  sua parcela de fala em tempo real.
- **Depois da reunião:** busca em todas as transcrições, ata por IA, análise de fala, exportação para
  Docs/Notion, PDF, Markdown, TXT, SRT, WebVTT e JSON.
- **Backup automático** numa pasta do computador (OneDrive ou Google Drive levam a outros computadores)
  e **ajustes sincronizados** pela conta do Chrome.

## Instalar

**Pelo site:** baixe o zip, descompacte e siga os passos abaixo com a pasta `reunilo/`.

**Pelo código:**
1. Clone este repositório.
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor** e clique em **Carregar sem compactação**.
3. Escolha a pasta `extension/`.

Quem já usava o Escriba pode trocar a pasta sem perder nada: o ID da extensão é o mesmo.

## Desenvolver

A extensão não tem etapa de build: o código em `extension/src` é o que o Chrome carrega.

```bash
cd extension
npm test                                                   # testes unitários
CHROME=/caminho/do/chrome node test/e2e-meet.mjs [pasta]   # ponta a ponta no Meet (simulado)
CHROME=/caminho/do/chrome node test/e2e-backup.mjs [pasta] # backup e restauração
```

Todos os testes estão descritos em [`extension/README.md`](extension/README.md#testes).

O site é estático, servido por Caddy em Docker (`site/docker-compose.yml`). O formulário de contato
(`site/contato/server.py`, só biblioteca padrão do Python) lê as credenciais de um arquivo `contato.env`
que fica apenas no servidor e nunca entra no repositório.

## Reunilo Pro (em planejamento)

Uma versão paga, de **R$ 15/mês ou US$ 3/mês**, com conta online, transcrições sincronizadas entre
computadores, uma área web para ler, buscar e compartilhar reuniões, e **15 créditos de IA por mês**
sem precisar de chave de API. Pagamento por Pix Automático ou cartão. O plano técnico completo está em
[`docs/TDD-reunilo-pro.md`](docs/TDD-reunilo-pro.md).

## Privacidade

A versão grátis não envia nada para servidor nenhum. A única conexão de rede é com a API do Claude, e
só quando você pede algo à IA usando a sua própria chave. O modelo do Whisper é baixado uma vez do
Hugging Face e fica no cache do navegador. Política completa em
[`site/privacidade.html`](site/privacidade.html).

## Créditos

- Reconhecimento de fala: [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0),
  incluído em `extension/vendor/transformers`, com modelos Whisper da OpenAI convertidos pela
  comunidade ONNX.
- Trecho de fala de teste: Wikipédia Falada, artigo "Brasil" (CC0).

## Licença

[GNU AGPL-3.0](LICENSE). Você pode usar, estudar, modificar e redistribuir o código. Quem distribuir uma
versão modificada, ou oferecê-la como serviço pela rede, precisa publicar o código-fonte sob a mesma
licença.

Feito por Thiago M. Meneses ([meneseslabs](https://meneseslabs.com.br)).
