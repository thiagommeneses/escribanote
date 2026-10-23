# Prompt — vídeo de lançamento SaaS do Escribanote (Remotion)

> Prompt refinado a partir de um pedido genérico ("Using Remotion, make me a launch video for the app, use the repo,
> 15–30 s, zooms, cursor, typing, interaction, showcase, different angles"). Este é o que foi usado.

---

Você vai produzir o vídeo de lançamento do **Escribanote**, uma extensão para Chrome e Edge que transcreve reuniões
(Google Meet, Teams, Zoom e huddles do Slack) com o nome de quem falou, gera a ata com IA e guarda tudo no computador
do usuário. Use o repositório como fonte única de verdade: o produto real está em `extension/` (painel lateral e app
em `src/app/app.html`, widget da reunião em `src/content/widget.js`) e o site em `site/`. Não invente telas: toda
imagem do produto deve ser uma captura real do app rodando, gerada por script e reproduzível.

**Formato.** Remotion (React), composição `Lancamento`, 1920×1080, 30 fps, 24 a 28 segundos, H.264. Projeto em
`marketing/remotion/`, renderizável com um único comando. Tudo determinístico: nada de `Math.random()` nem de
animação dependente de relógio.

**Estilo.** Vídeo de lançamento de SaaS, Apple-like: fundo de estúdio escuro com um gradiente quente discreto, a tela
do app flutuando num "device frame" de janela do navegador com sombra profunda, tipografia do site (Fraunces
itálico para títulos, Hanken Grotesk para texto), cor de destaque laranja-telha da marca. Movimento com molas
(`spring`), nunca linear. Cortes em cima da batida da música.

**O que mostrar, nesta ordem, cada bloco de 3 a 5 segundos:**

1. **Gancho** (0–3 s): título grande "Cada palavra da reunião, anotada." A janela do app entra por baixo com uma
   leve rotação 3D e assenta no centro.
2. **Lista de reuniões**: zoom suave na lista; o cursor desce e clica na reunião de hoje (ripple no clique).
3. **Transcrição com nomes**: a janela inclina em perspectiva (ângulo 3/4); zoom em dois blocos de fala; os chips
   dos participantes ganham um destaque. Legenda: "Quem disse o quê, ao vivo."
4. **Renomear e mesclar**: o cursor clica no nome de um falante, o editor flutuante abre, o nome é digitado letra por
   letra (com cursor piscando), Enter; o chip muda. Legenda: "Nomes certos. Dois iguais? Ele junta."
5. **Pergunte à IA**: aba IA; uma pergunta é digitada no campo ("O que ficou decidido?") e a resposta aparece em
   streaming. Legenda: "Pergunte à reunião."
6. **Ata e análise**: corte para a ata gerada e para o painel de análise (participação por pessoa); zoom nas barras.
   Legenda: "A ata pronta quando a chamada acaba."
7. **Widget na reunião**: captura do widget dentro do Meet, com ângulo diferente (visto de cima, leve dolly);
   legenda: "Dentro do Meet, do Teams, do Zoom e do Slack."
8. **Fechamento**: ícone e nome, "Grátis para instalar · Chrome e Edge", URL `escribanote.meneseslabs.com.br`,
   badge "Tudo fica no seu computador".

**Elementos obrigatórios.** Cursor vetorial (seta macOS) com movimento por mola e clique com onda; efeito de
digitação com velocidade humana (variação por caractere, pausas em pontuação); zoom e pan com easing; pelo menos
dois ângulos 3D diferentes da janela (frontal e 3/4 inclinada); legendas de uma linha, sempre dentro da área segura;
trilha instrumental e efeitos sutis (clique, pop, whoosh) alinhados aos eventos; sem narração.

**Entrega.** `marketing/remotion/` com `package.json`, `src/Root.tsx` (composição), `src/scenes/*`, componentes
`Cursor`, `Typing`, `Browser` (device frame) e um script `capturas.mjs` que gera as imagens do app a partir do
produto real. Saída em `out/escribanote-lancamento-saas.mp4`. Documentar no `ROTEIRO.md` a ordem das cenas, os
tempos e o comando de render.
