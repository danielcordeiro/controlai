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
- Nome da carteira e **e-mail de recuperação**.
- **Exportar CSV** de todas as despesas (abre no Excel/Sheets).

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
4. Cada função valida que a categoria/forma **pertence à carteira** informada —
   não dá para gravar na carteira dos outros nem com o id na mão.

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

1. Rode `supabase/schema.sql` inteiro no **SQL Editor** (é idempotente).
2. Em **Authentication → URL Configuration**, inclua a URL do app em
   **Redirect URLs** (ex.: `https://danielcordeiro.github.io/controlai/**`).
   Sem isso o link mágico da recuperação volta para a Site URL do projeto.
3. (Opcional) Para o app aceitar **código de 6 dígitos** além do link, edite o
   template **Magic Link** em *Authentication → Email Templates* incluindo
   `{{ .Token }}`. O app aceita os dois caminhos.
4. (Opcional) Com o SMTP padrão do Supabase o envio é **limitado a poucos e-mails
   por hora**. Para uso real, configure um SMTP próprio em *Project Settings → Auth*.

O projeto compartilha a instância com o Rachaí: nada de `public` foi alterado, e o
analytics reaproveita a função `public.track()` já existente, com os eventos
prefixados (`controlai:pageview`).

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
