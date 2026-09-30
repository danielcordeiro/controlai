# 💸 Controlaí

> **Gastou, anotou.** Saiba para onde foi seu dinheiro no mês.

Controle de despesas pessoais com **infra mínima**: front estático (GitHub Pages) +
Supabase (Postgres) para os dados. **Sem login, sem servidor para manter, sem build.**

**🔗 No ar:** https://danielcordeiro.github.io/controlai/

Crie sua **carteira**, lance a despesa em segundos (**valor, data, categoria** e,
se quiser, **forma de pagamento**) e veja o mês fechado **por categoria** — com
comparação com o mês anterior.

---

## ✨ Funcionalidades

A carteira abre em 4 abas:

### 📊 Mês
- **Total do mês** e comparação com o mês anterior ("18% a mais que agosto").
  Quando há parcela a pagar, o total se divide em **Pago · A pagar**.
- **Cartões de resumo:** nº de lançamentos, média por dia, maior categoria e
  **projeção do mês** (no mês corrente, a partir do dia 7). Só o gasto avulso é
  extrapolado; fixas e parcelas entram uma vez. A conta é do servidor, a mesma
  que a IA lê.
- **Limite do mês**, para o total e para cada categoria principal (as
  subcategorias somam nela). Conta tudo o que entra no total: pagas e a pagar,
  avulsas, fixas e parcelas. No card do total, uma barra em duas partes (fixas e
  parcelas × dia a dia), quanto está livre, "até R$ X/dia" e, a partir do dia 7,
  onde o mês fecha no ritmo atual. O card **Limites** mostra cada categoria
  limitada — quem passou primeiro. A folha **Limites** mostra, ao lado de cada
  campo, quanto do mês já é de fixas e parcelas; vazio remove.
- O limite vale **do mês atual em diante**: os meses passados guardam o que
  tinham e mostram quanto sobrou ou passou. Nunca impede um lançamento, só avisa.
- **Mês futuro**: "Já comprometido" com as fixas e parcelas previstas, e quanto
  delas ainda vai pedir confirmação; com limite, quanto sobra para o dia a dia.
- **Rosca de gastos por categoria** (SVG puro, sem libs) com legenda e %.
- **Barras por categoria**, com detalhamento das **subcategorias** quando existem.
- **Por forma de pagamento** (quanto foi no Pix, no cartão...).
- **Maiores despesas** do mês.

### 🧾 Despesas
- Lançamentos **agrupados por dia**, com o total de cada dia.
- Selos `fixa`, `3/10` (a parcela), `a pagar` e `atrasada`.
- Toque para **editar** ou **excluir**.

### 🔁 Despesas fixas e parceladas
- No formulário da despesa, marque **Repetir ou parcelar** e escolha por quantas
  vezes: `3x`, `6x`, `10x`, `12x`, `24x`, **outro** (qualquer número até 600) ou
  **até você cancelar**.
- Com número de vezes, o valor pode ser **da parcela** ou o **total**: o app
  divide e mostra a prévia ("1ª R$ 333,34 + 2x R$ 333,33"). Os centavos que
  sobram vão na 1ª parcela, e a soma fecha no total.
- A série é uma **regra**, não dez lançamentos adiantados: a ocorrência de cada
  mês é lançada quando aquele mês chega, **no dia da série** (15/10, 15/11...).
  Dia 31 em mês de 30 cai no último dia do mês, não vaza para o seguinte.
- **Os meses que vêm aparecem como "Já comprometido"**, separado do gasto:
  "Gastei" continua sendo só o que já aconteceu.
- **Cartão**: as parcelas já nascem pagas, a compra está feita. **Boleto ou
  carnê**: marque *Preciso confirmar cada pagamento* e cada parcela nasce
  **a pagar** — conta no gasto do mês do vencimento com o selo, vira `atrasada`
  depois do vencimento e fica paga com **Marcar como paga** (dá para desfazer).
  A opção vem desmarcada e vale também para fixa, não só para parcelado.
- **Contas a pagar**: um card na aba Mês mostra as atrasadas, o que vence no mês
  e a próxima. O toque abre a lista, por vencimento, com **Paguei** em cada uma
  e o andamento de cada série a confirmar ("Geladeira — 3 de 10 pagas · falta
  R$ 2.100").
- **Parcelamento cadastrado em andamento**: as parcelas que venceram antes do
  cadastro entram como pagas (são histórico). Se alguma não foi paga, *Voltar
  para a pagar*.
- **Apagar a ocorrência de um mês** vale só para aquele mês — a série continua e
  não recria o que você apagou. Apagar uma parcela a pagar quer dizer "esta não
  será paga"; se você pagou, é **Marcar como paga**.
- **Cancelar** para de lançar do mês que vem em diante e preserva o histórico —
  as parcelas a pagar continuam pendentes, a dívida não some. **Reativar** volta
  a lançar a partir do mês atual, sem ressuscitar os meses em que ela esteve
  parada. **Excluir** apaga só a regra e os lançamentos continuam, soltos da
  série; para quem cadastrou errado, **apagar também os lançamentos** leva tudo.
- **Quitar antecipado** não tem botão: cancele a série, apague as parcelas a
  pagar que a quitação cobre e lance a quitação como despesa avulsa. Pagar
  adiantado também não: a parcela se paga quando o mês dela chega.
- Mudar o valor vale **daqui para frente**; o que já foi lançado fica como está.
- A lista fica em **Ajustes → Fixas e parceladas**, com o andamento, editar,
  pausar/reativar e excluir.

### 🗂️ Categorias
- **Plano de contas** de até 2 níveis (ex.: `Alimentação › Restaurante`).
- Cor por categoria, **arquivar** (some do formulário e preserva o histórico) e excluir.
- **Formas de pagamento** — informar é opcional em cada despesa.

### 🤖 IA
- **Conector no Claude**: a aba entrega a URL pronta para colar em
  *Customize → Connectors → Add custom connector*. Aí é só falar:
  *"gastei 62 no mercado hoje"*, *"resumo do mês"*, *"quanto foi em transporte?"*,
  *"todo mês pago 1500 de aluguel"* (isso vira uma fixa, não um lançamento solto),
  *"sobe o aluguel para 1650"* (edita a série, sem mexer no que já foi lançado),
  *"comprei uma TV em 10x de 300 no cartão"*, *"paguei a parcela da geladeira"*,
  *"o que falta pagar?"*, *"limite de 800 para alimentação"*, *"quanto ainda
  posso gastar?"*, *"vou estourar?"*. Ao lançar, a IA diz quanto ficou livre.
- Para **Claude Code, Cursor ou ChatGPT**, um bloco de instruções para colar na
  conversa, que usa a API REST direto.
- **Token separado do link**: revogar o acesso da IA não derruba o seu link, e
  trocar o link não desconecta a IA.

### ☕ Apoio
- No fim da aba Mês, um card discreto com a chave **Pix** para quem quiser pagar
  um café. É opt-in: sem o bloco `PIX` no `config.js`, o card nem aparece.

### ⚙️ Ajustes
- Seu **ID/link** de acesso, com botão de copiar.
- Nome da carteira e **e-mail de recuperação** (o antigo continua valendo para recuperar).
- **Exportar Excel (.xlsx)**: data como data, valor como moeda, cabeçalho
  congelado e filtro — dá para somar e montar tabela dinâmica na hora. CSV
  continua disponível como alternativa.
- **Gerar um ID novo** — se o link vazar, isso derruba o antigo na hora sem perder nada.
- **Apagar a carteira** de vez, self-service.

### Em todo o app
- **Mobile-first**, com botão flutuante **＋ Despesa** sempre à mão.
- Lançar leva poucos toques: valor → categoria → salvar (a data já vem hoje).
- **Navegação entre meses** (‹ ›); com fixa ou parcelado ativo, o › vai até o
  último mês previsto para mostrar o que já está comprometido.
- Valores em **centavos inteiros** — sem erro de arredondamento.
- Carteiras abertas neste aparelho ficam listadas na home.

---

## 🔑 Acesso: UUID + recuperação por e-mail

- Cada carteira é um **UUID** e o link `#/c/<uuid>` é a chave: quem tem o link, entra.
- Na criação você informa um **e-mail**. Ele serve **só** para recuperar o ID.
- **Perdeu o link?** Em *Recuperar meu ID*, informe o e-mail: o Supabase Auth manda
  um **link mágico** (ou um **código de 6 dígitos**). Ao voltar autenticado, o app
  lista as carteiras daquele e-mail.
- A lista **nunca** sai de um campo digitado: a função `controlai_meus_ids()` lê o
  e-mail **do JWT**, ou seja, de quem provou ter acesso à caixa de entrada.
  Digitar o e-mail de outra pessoa não devolve nada.

---

## 📁 Estrutura

```
index.html            # casca (carrega config.js e o módulo)
config.js             # URL + publishable key do Supabase e chave Pix de apoio
config.example.js     # modelo para quem for clonar
styles.css            # design system (mobile-first)
js/
  app.js              # telas, rotas e interações
  db.js               # chamadas RPC + fluxo de recuperação (Supabase Auth)
  report.js           # agregações do mês (puras, testadas)
  ui.js               # DOM, dinheiro em centavos, datas/meses, toasts
  xlsx.js             # gerador de .xlsx (ZIP + OOXML), sem dependência
supabase/
  schema.sql          # tabelas + RPCs + permissões (idempotente)
  fixas.sql           # fixas e parceladas: tabelas, geração mês a mês,
                      # projeção do futuro, contas a pagar e RPCs
                      # (roda depois do schema.sql, que já chama o que ele cria)
  api-ia.sql          # token e funções da API para IA
  checks.sql          # asserts das fixas/parcelados/limites para um
                      # Postgres descartável — nunca o Supabase
  analytics.sql       # relatórios de uso separados dos do Rachaí
  functions/controlai-mcp/   # servidor MCP (Edge Function) do conector
tests/unit.mjs        # testes das funções puras
docs/                 # doc técnica e operação
```

---

## 🔒 Segurança

Mesmo modelo do [Rachaí](https://github.com/danielcordeiro/rachai), um passo mais restrito:

1. As **tabelas ficam no schema `controlai`**, que **não é exposto** pelo PostgREST —
   a API sequer enxerga `controlai.expense`.
2. **RLS ligada** em todas as tabelas, **sem policy pública**.
3. Todo acesso passa pelas funções `public.controlai_*` (`SECURITY DEFINER`), as
   únicas com `GRANT EXECUTE` para `anon`.
4. **Toda mutação exige o id da carteira**, não só o do objeto: conhecer o uuid de
   uma despesa ou categoria solta não permite alterá-la nem apagá-la.
5. `EXECUTE` é revogado de `PUBLIC` e concedido só a `anon`/`authenticated`
   (no Postgres a função nasce aberta para `PUBLIC`), e `search_path` é fixo com
   `pg_temp` em todas elas.
6. O link é uma chave portadora, então existe revogação: **gerar um ID novo** em
   Ajustes invalida o anterior.

A `publishable key` no `config.js` é **pública por design** (é o que o navegador usa);
o que protege os dados é o modelo acima.

---

## 🛠️ Rodar local

```bash
git clone https://github.com/danielcordeiro/controlai.git
cd controlai
cp config.example.js config.js   # e preencha com os dados do seu Supabase
python3 -m http.server 8899      # abre em http://127.0.0.1:8899
npm test                         # testes das funções puras
```

Não há build: é HTML + CSS + ES modules servidos estaticamente.

Os asserts do SQL (fixas, parcelados, contas a pagar, limites e projeção) rodam num Postgres
descartável; o passo a passo está no cabeçalho de `supabase/checks.sql`.

---

## ☁️ Supabase

### Já está pronto (instância do Daniel, projeto `wkuykhomucxskelbcpmi`)
- `supabase/schema.sql` e `supabase/analytics.sql` **já aplicados**: tabelas,
  RPCs e permissões estão no ar e testados.
- O app na URL acima já cria carteira, lança despesa e fecha o mês.

### Falta você fazer (2 minutos no painel) — só a recuperação depende disso
1. **Authentication → URL Configuration → Redirect URLs**: adicionar
   `https://danielcordeiro.github.io/controlai/**`.
   Sem isso o link mágico volta para a *Site URL* do projeto e a recuperação de
   ID não fecha. **Tudo o mais funciona sem esse passo.**
2. Depois, teste de ponta a ponta: crie uma carteira, toque em *Testar a
   recuperação*, abra o e-mail e confira se volta autenticado.

### Opcional
- **Código de 6 dígitos** além do link: incluir `{{ .Token }}` no template
  *Magic Link* em *Authentication → Email Templates*. O app aceita os dois.
- **SMTP próprio** em *Project Settings → Auth*: o serviço embutido do Supabase
  é limitado a poucos e-mails por hora e não é recomendado para produção.

### Convivência com o Rachaí
Mesma instância, zero alteração no que é dele: as tabelas do Controlaí ficam no
schema `controlai` e as funções levam prefixo. O analytics reaproveita o
`public.track()` existente com eventos `controlai:*`, e os relatórios foram
separados — `analytics_summary()` voltou a contar só o Rachaí e
`controlai_analytics_summary()` conta só este app.

### Conector de IA (MCP)
O servidor MCP roda como Edge Function no mesmo projeto, em
`supabase/functions/controlai-mcp/`. Já está publicado. Para reimplantar:

```bash
supabase functions deploy controlai-mcp --no-verify-jwt --project-ref wkuykhomucxskelbcpmi
```

`--no-verify-jwt` é obrigatório: o claude.ai não manda chave do Supabase, e a
autenticação é o token `ctl_...` no fim da URL, validado dentro da função.

Ferramentas expostas (15): `contexto`, `lancar_despesa`, `resumo_do_mes`,
`definir_limite`, `listar_despesas`, `editar_despesa`, `apagar_despesa`,
`criar_fixa`, `lancar_parcelado`, `editar_fixa`, `listar_fixas`,
`cancelar_fixa`, `marcar_pago`, `contas_a_pagar`, `criar_categoria`.

Ao publicar uma versão, a ordem é **SQL → Edge Function → front**: todo parâmetro
novo tem default, então a Edge e o front antigos continuam funcionando com o SQL
novo, mas não o contrário (o front 1.4.0 lê a média e a projeção do SQL). Quando
a lista de ferramentas muda, **reconecte o conector no claude.ai**: ele guarda
as ferramentas em cache e não enxerga as novas até lá. O SQL é `schema.sql`, `fixas.sql` e `api-ia.sql`
**juntos, numa transação só** (veja abaixo): o `schema.sql` novo chama o que o
`fixas.sql` cria, e aplicado sozinho deixaria o app no ar chamando função que
ainda não existe.

### Se for clonar em outro projeto Supabase
Rode `supabase/schema.sql`, `supabase/fixas.sql` e `supabase/api-ia.sql`
**juntos, numa transação**, e depois `supabase/analytics.sql` (todos
idempotentes):

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f supabase/schema.sql -f supabase/fixas.sql -f supabase/api-ia.sql
```

No editor SQL do painel, cole os três juntos, nessa ordem, e rode de uma vez.
Depois publique a Edge Function e preencha o `config.js` a partir do
`config.example.js`. A ordem importa: `schema.sql` cria funções que chamam o que
`fixas.sql` define depois (corpo plpgsql não resolve nomes na criação, então isso
é válido); a transação garante que nunca fica um sem o outro.

---

## 🚀 Deploy

Push na `main` publica no GitHub Pages (Settings → Pages → branch `main`, pasta `/`).

---

## 🔐 Privacidade

O app guarda as despesas, o nome da carteira e o e-mail de recuperação. Sem anúncios,
sem cookies de rastreamento, sem terceiros além da biblioteca do Supabase.
Detalhes em [privacy.html](https://danielcordeiro.github.io/controlai/privacy.html).

## 📄 Licença

MIT.
