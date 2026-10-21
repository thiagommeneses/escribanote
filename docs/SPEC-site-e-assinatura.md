# SPEC-01 — Site com o Pro, página de planos e nova assinatura

| Campo | Valor |
|---|---|
| Fatia | FAT-01 — "Visitante entende que o Escribanote é local e grátis, descobre o Pro e consegue assinar no plano certo" |
| Rastreabilidade | OUT-01, OUT-02 › ACT-01..03 › US-001..US-010 |
| Autor / Data | Thiago M. Meneses (decisões) · Claude (redação) · 2026-10-20 |
| Status | implementada (aguardando validação com usuários) |
| Versão | 1.0 |

Marcas: `[FATO]` dito pelo dono do produto ou verificado; `[HIPÓTESE]` assumido; `[A VALIDAR]` com o experimento que resolve.

## 0. Descoberta enxuta

### Problema e resultado

- **OUT-01 (negócio):** gerar as primeiras assinaturas do Escribanote Pro sem perder instalações do plano grátis. Linha de base: 0 assinantes, Pro ainda não lançado `[FATO]`.
- **OUT-02 (usuário):** quem chega ao site entende em segundos que a transcrição fica no próprio computador e que a nuvem é uma escolha opcional e paga `[FATO: diretriz do dono — "sem tirar o foco da segurança local que é a chave principal"]`.

### Proposta de valor

*Para profissionais que fazem reuniões no Meet, Teams, Zoom ou Slack e não querem as conversas no servidor de terceiros, o Escribanote é um transcritor que roda no navegador e guarda tudo no computador, diferente dos transcritores em nuvem porque a privacidade é o padrão grátis, não um plano pago. Quem quer as reuniões em vários computadores e IA sem chave assina o Pro, que custa uma fração dos concorrentes.*

### Pesquisa de mesa (sem entrevistas ainda)

| Observação | Fonte | Marca |
|---|---|---|
| O concorrente de referência cobra US$ 8/usuário/mês no Pro anual (cerca de US$ 12 no mensal) | [tactiq.io/pricing](https://tactiq.io/pricing) | `[FATO]` |
| Concorrentes exibem selos de conformidade (SOC 2, GDPR) como argumento de confiança | sites de comparação | `[HIPÓTESE]`: selos não verificados nas páginas oficiais |
| O Escribanote Pro custa R$ 15/mês ou US$ 3/mês; anual R$ 150 ou US$ 30 (2 meses grátis) | decisão do dono | `[FATO]` |
| Pix só no anual; mensal só no cartão | decisão do dono | `[FATO]` |
| O servidor do Pro fica em Boston (EUA); os dados ficam cifrados (AES-256-GCM) | VPS e código | `[FATO]` |
| Não há certificação SOC 2/ISO nem DPA formal | — | `[FATO]`: nenhuma página pode alegar certificação |

**Implicação:** o argumento de preço é forte (cerca de 1/3 do concorrente), mas o diferencial principal continua a privacidade local. Segurança e conformidade do Pro devem ser descritas como práticas concretas e direitos garantidos, nunca como selo.

### Perfis (provisórios)

- **P1 — Profissional cuidadoso** `[HIPÓTESE]`: faz várias reuniões por semana, tem receio de mandar conversas para a nuvem e instala o grátis.
- **P2 — Quem usa vários computadores** `[HIPÓTESE]`: alterna entre notebook e desktop, não tem chave da API e quer a ata pronta. É o comprador do Pro.

### Hipóteses de risco

| ID | Hipótese | Dói se errada | Experimento |
|---|---|---|---|
| H-01 | Mostrar o Pro na home não reduz a confiança no "local" | Alto | EXP-01 |
| H-02 | O anual (com Pix) converte mais que o mensal no Brasil | Médio | EXP-02 |
| H-03 | Explicar a conformidade (LGPD/GDPR/CCPA) em linguagem simples aumenta a confiança para assinar | Médio | EXP-01 |

### Crítica do site anterior (antes do redesign)

- **Funciona bem:** a identidade editorial (papel, tinta, vermelho REC, marca-texto) e a demonstração do widget.
- **Problema crítico:** o texto "o código não fala com servidores do Escribanote, porque eles não existem" fica falso quando o Pro existe. É preciso deixar claro que isso vale para o plano grátis e para quem não conecta a conta.
- **Problemas moderados:**
  - O herói não tinha prova visual da tese "fica no seu computador".
  - A demonstração começa vazia, o que no primeiro segundo parece um vídeo quebrado.
  - Não havia caminho para quem já tem conta ("Entrar").
- **Problema menor:** os números de prova (0 · 4 · ∞) tinham baixo contraste.

## 1. Escopo

**Incluído:**

- Home redesenhada, com motion:
  - herói em camadas;
  - diagrama animado "o caminho da sua fala";
  - seção "Grátis para sempre × Pro opcional";
  - textos de privacidade corrigidos.
- Menu com "Pro" e "Entrar".
- Página `/pro/`:
  - seletor anual/mensal e real/dólar;
  - planos, segurança e conformidade;
  - perguntas frequentes.
- No app (`/app/#/conta`), a seção "Assine o Escribanote Pro" com o mesmo seletor, as formas de pagamento por plano e o bloco de segurança.
- Servidor:
  - quatro preços (BRL/USD × mês/ano), Pix só no anual BRL;
  - créditos mensais no plano anual.
- Política de privacidade: direitos para quem está na UE (GDPR) e nos EUA (CCPA/CPRA).

**Não incluído (e por quê):**

- Troca de plano mensal↔anual pelo portal. Uma assinatura no Pix Automático não pode virar mensal sem cartão; fica para depois do beta.
- Selos de certificação: o Escribanote não tem nenhuma.
- Versão em inglês do site: o público inicial é o Brasil `[HIPÓTESE]`.

## 2. Histórias e critérios de aceite

### US-001 — Entender a tese local em segundos (OUT-02)

```gherkin
AC-001.1 Dado que abro a home, Quando o herói termina de aparecer, Então leio que a transcrição fica no meu computador e vejo "Baixar grátis" como ação principal.
AC-001.2 Dado prefers-reduced-motion, Quando abro a home, Então todo o conteúdo aparece sem animação e a demonstração já mostra as falas.
```

### US-002 — Descobrir o Pro sem confundir com o grátis (OUT-01, H-01)

```gherkin
AC-002.1 Dado que estou em qualquer página do site, Quando olho o menu, Então vejo "Pro" levando a /pro/ e "Entrar" levando a /app/.
AC-002.2 Dado que rolo a home, Quando chego em "Dois jeitos de usar", Então vejo o grátis como padrão ("nada sai do seu computador") e o Pro como opcional, com o preço anual.
AC-002.3 Dado o texto de privacidade da home, Então ele não afirma que não existem servidores do Escribanote; diz que a extensão sem conta conectada não fala com servidor nenhum.
```

### US-003 — Escolher o plano na página do Pro (OUT-01, H-02)

```gherkin
AC-003.1 Dado /pro/, Quando a página abre, Então "Anual" e "Real" vêm selecionados e mostro R$ 150/ano, "R$ 12,50 por mês", "2 meses grátis", "Pix ou cartão" e o preço cheio R$ 180 riscado.
AC-003.2 Quando troco para "Mensal", Então mostro R$ 15/mês e "Só cartão de crédito", com transição sem salto de layout.
AC-003.3 Quando troco para "Dólar", Então mostro US$ 30/ano (US$ 36 riscado) ou US$ 3/mês, sempre "Cartão".
AC-003.4 Quando clico em "Assinar", Então vou para /app/#/conta?plano=<anual|mensal>&moeda=<brl|usd>, e o app mantém essa escolha depois do login.
```

### US-004 — Confiar na segurança do Pro (OUT-01, H-03)

```gherkin
AC-004.1 Dado /pro/ ou a seção de assinatura do app, Então vejo, em linguagem simples:
  - criptografia em trânsito (HTTPS) e em repouso (AES-256);
  - backups diários cifrados;
  - sem venda de dados e sem uso para treinar IA;
  - exportar e apagar a qualquer momento;
  - servidor nos EUA, informado na política.
AC-004.2 Então vejo LGPD, GDPR e leis de privacidade dos EUA (CCPA) descritas como "direitos que garantimos", sem alegar certificação.
```

### US-005 — Assinar com a forma de pagamento certa (OUT-01)

```gherkin
AC-005.1 Dado anual + real, Quando assino, Então o Checkout oferece cartão e Pix Automático anual (teto de R$ 180).
AC-005.2 Dado mensal + real, Quando assino, Então o Checkout oferece só cartão.
AC-005.3 Dado dólar, Então o Checkout oferece só cartão, no anual (US$ 30) ou no mensal (US$ 3).
AC-005.4 Dado a Stripe ainda não configurada, Quando assino, Então vejo "Este plano ainda não está disponível. Tente mais tarde." e nada quebra.
```

### US-006 — Receber os créditos todo mês no anual (OUT-01)

```gherkin
AC-006.1 Dado uma assinatura anual paga, Então recebo 15 créditos na fatura, e o próximo lote é anunciado para um mês depois.
AC-006.2 Quando passa cada mês do período, Então recebo mais 15 (com teto de 30), uma vez por mês, até completar 12 lotes no ano.
```

## 3. Regras de negócio

| ID | Regra |
|---|---|
| RN-01 | Pix existe só no plano anual em reais (Pix Automático, cobrança anual). |
| RN-02 | Anual = 10 × o mensal: R$ 150 e US$ 30. Mostrar o preço cheio (12 ×) riscado e "2 meses grátis". |
| RN-03 | O padrão do seletor é anual + real. |
| RN-04 | Créditos: 15 por mês nos dois planos, acumulando até 30. |
| RN-05 | Nenhuma página alega certificação (SOC 2, ISO) que o Escribanote não tem. |
| RN-06 | A home mantém o grátis/local como mensagem principal; o Pro aparece depois da tese local e nunca no herói como ação principal. |

## 4. Requisitos não funcionais

- **Acessibilidade:**
  - os seletores são `radiogroup` navegáveis por teclado;
  - o foco é visível;
  - o contraste dos textos é de pelo menos 4,5:1;
  - com `prefers-reduced-motion`, nenhuma animação de entrada nem de rolagem.
- **Desempenho:** sem framework e sem bibliotecas externas; as animações usam só `transform` e `opacity`. A home continua estática.
- **Navegadores:** as View Transitions entre páginas são um aprimoramento; sem suporte, a navegação é normal.

## 5. Telemetria

Não se aplica por decisão de produto: o site não tem rastreadores (é parte da proposta de valor). As únicas medidas são:

- os logs da própria API (`audit_log` com `checkout {currency, interval}`);
- as assinaturas na Stripe.

## 6. Validação (fase 4)

- **EXP-01 (H-01, H-03):**
  - mostrar a home e /pro/ a 5 pessoas do perfil P1/P2 (beta);
  - tarefa: "você usaria? onde ficam suas reuniões?".
  - **Invalida se** 2 ou mais acharem que o grátis manda dados para a nuvem.
- **EXP-02 (H-02):** nos primeiros 20 assinantes, comparar a proporção entre anual e mensal pelo `audit_log`. **Revisar o padrão do seletor se** menos de 30% escolherem o anual.

## 7. Definição de pronto

- 38 testes do servidor passando, incluindo o anual e os créditos mensais.
- E2E do app passando.
- Home e /pro/ verificadas em 1440 px e 390 px, com e sem movimento reduzido.
- Publicado em produção e com a política atualizada.
