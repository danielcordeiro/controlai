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
- **Cartões de resumo:** nº de lançamentos, média por dia, maior categoria e
  **projeção do mês** (no mês corrente).
- **Rosca de gastos por categoria** (SVG puro, sem libs) com legenda e %.
- **Barras por categoria**, com detalhamento das **subcategorias** quando existem.
- **Por forma de pagamento** (quanto foi no Pix, no cartão...).
- **Maiores despesas** do mês.

### 🧾 Despesas
- Lançamentos **agrupados por dia**, com o total de cada dia.
- Toque para **editar** ou **excluir**.

### 🗂️ Categorias
- **Plano de contas** de até 2 níveis (ex.: `Alimentação › Restaurante`).
- Cor por categoria, **arquivar** (some do formulário e preserva o histórico) e excluir.
- **Formas de pagamento** — informar é opcional em cada despesa.

### ⚙️ Ajustes
- Seu **ID/link** de acesso, com botão de copiar.
- Nome da carteira e **e-mail de recuperação** (o antigo continua valendo para recuperar).
- **Exportar CSV** de todas as despesas (abre no Excel/Sheets).
- **Gerar um ID novo** — se o link vazar, isso derruba o antigo na hora sem perder nada.
- **Apagar a carteira** de vez, self-service.

### Em todo o app
- **Mobile-first**, com botão flutuante **＋ Despesa** sempre à mão.
- Lançar leva poucos toques: valor → categoria → salvar (a data já vem hoje).
- **Navegação entre meses** (‹ ›), sem oferecer mês futuro.
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
config.js             # URL + publishable key do Supabase (pública por design)
config.example.js     # modelo para quem for clonar
styles.css            # design system (mobile-first)
js/
  app.js              # telas, rotas e interações
  db.js               # chamadas RPC + fluxo de recuperação (Supabase Auth)
  report.js           # agregações do mês (puras, testadas)
  ui.js               # DOM, dinheiro em centavos, datas/meses, toasts
supabase/
  schema.sql          # tabelas + RPCs + permissões (rodar uma vez)
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

### Se for clonar em outro projeto Supabase
Rode `supabase/schema.sql` inteiro (idempotente) e depois `supabase/analytics.sql`,
e preencha o `config.js` a partir do `config.example.js`.

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
