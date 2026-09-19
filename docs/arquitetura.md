# Controlaí — arquitetura e decisões

**Data:** 19/09/2026
**Stack:** HTML + CSS + ES modules (sem build) no GitHub Pages · Supabase (Postgres 17)
**Projeto Supabase:** `wkuykhomucxskelbcpmi` — o **mesmo do Rachaí**

---

## 1. Por que este formato

O Rachaí provou que dá para entregar um app útil com front estático e Postgres,
sem servidor para manter. O Controlaí repete a receita e reaproveita o design
system, os helpers de UI e o modelo de segurança. O que muda é o domínio:
em vez de dividir conta entre pessoas, é **acompanhar o próprio gasto mensal**.

---

## 2. Convivência com o Rachaí no mesmo Supabase

O schema `public` já é do Rachaí: `events`, `people`, **`expenses`**, **`payments`**,
`add_expense()`, `get_event()` etc. Colidir ali seria fácil e caro.

Decisão:

| O quê | Onde | Por quê |
|---|---|---|
| Tabelas | schema **`controlai`** | fora do `public`, sem risco de colisão; o PostgREST **não expõe** esse schema, então a API sequer enxerga as tabelas |
| Funções RPC | `public.controlai_*` | o PostgREST só chama funções em schema exposto; o prefixo evita ambiguidade com as do Rachaí |
| Analytics | `public.track()` do Rachaí | não vale uma tabela nova; os eventos vão prefixados (`controlai:pageview`) e o relatório existente separa por nome |

Nada do Rachaí foi alterado — nem tabela, nem função, nem permissão.

---

## 3. Modelo de dados

```
controlai.ledger          carteira (a unidade de acesso)
  id uuid pk              ← a chave portadora: quem tem o link, entra
  name, email             ← e-mail só para recuperar o id
  created_at, last_seen_at

controlai.category        plano de contas, até 2 níveis
  id, ledger_id, parent_id (self-FK, null = 1º nível)
  name, color, sort_order, archived
  unique (ledger_id, coalesce(parent_id, zero-uuid), lower(name))

controlai.payment_method  forma de pagamento (opcional na despesa)
  id, ledger_id, name, sort_order, archived

controlai.expense         a despesa
  id, ledger_id
  spent_on date           ← obrigatória
  amount_cents integer    ← > 0, sempre em centavos inteiros
  category_id             ← obrigatória, ON DELETE RESTRICT
  payment_method_id       ← OPCIONAL, ON DELETE SET NULL
  description, created_at, updated_at
  index (ledger_id, spent_on desc)   ← a consulta quente: um mês de uma carteira
```

**Centavos inteiros** (convenção herdada do Rachaí): nenhum `float` no caminho do
dinheiro, a soma sempre fecha.

**Categoria obrigatória, forma opcional** — exatamente o que o produto pede. A
forma de pagamento é uma dimensão secundária de análise, não um bloqueio no
lançamento.

**Arquivar em vez de excluir**: categoria com histórico não pode ser apagada
(`controlai_del_categoria` recusa e explica). Arquivada, some do formulário e
continua explicando os meses passados.

---

## 4. Segurança

Quatro camadas, da mais externa para a mais interna:

1. **Schema não exposto.** `controlai` não está na lista de schemas do PostgREST.
   `GET /rest/v1/expense` com `Accept-Profile: controlai` responde
   *"Invalid schema: only public, graphql_public are exposed"*.
2. **RLS ligada, sem policy.** Nenhuma linha é legível/gravável por `anon`.
3. **Gateway por função.** Só as `public.controlai_*` (`SECURITY DEFINER`,
   `set search_path = controlai, public`) têm `GRANT EXECUTE`. As funções
   internas (`controlai._ledger_ok` etc.) têm o execute revogado.
4. **Validação de posse dentro da função.** Toda escrita confere que a
   categoria/forma **pertence à carteira** informada. Ter o id de uma categoria
   alheia não permite gravar nela.

O UUID v4 da carteira é a credencial (122 bits — não se adivinha). É o mesmo
modelo de "link secreto" do Rachaí, e está declarado na UI: *"quem tem o link,
abre a carteira"*.

### Recuperação do ID — o ponto delicado

Mostrar o UUID para quem digita um e-mail seria um furo: qualquer um que soubesse
o e-mail leria as despesas. Por isso o e-mail precisa ser **provado**:

```
usuário digita e-mail
   → supabase.auth.signInWithOtp()        (link mágico e/ou código de 6 dígitos)
   → usuário abre o e-mail e volta autenticado
   → controlai_meus_ids() lê auth.jwt()->>'email'   ← do token, não do formulário
   → devolve as carteiras daquele e-mail
```

Sem sessão, a função levanta *"Confirme o e-mail para recuperar seus IDs."*
(verificado: chamada anônima é recusada).

**Configuração necessária no Supabase** (uma vez, no painel):
- *Authentication → URL Configuration → Redirect URLs*: incluir
  `https://danielcordeiro.github.io/controlai/**`. Sem isso o link mágico volta
  para a Site URL do projeto (que é do Rachaí).
- *Authentication → Email Templates → Magic Link*: incluir `{{ .Token }}` se quiser
  que o e-mail traga também o código de 6 dígitos. O app aceita os dois caminhos
  (link e código), então isso é opcional.
- O SMTP embutido do Supabase limita a poucos e-mails por hora. Para uso real,
  configurar SMTP próprio.

---

## 5. RPCs

| Função | Para quê |
|---|---|
| `controlai_criar(name, email)` | cria a carteira e **semeia** 10 categorias e 5 formas de pagamento, para a pessoa já sair lançando |
| `controlai_mes(ledger, mes)` | **uma chamada** devolve tudo da tela: carteira, categorias, formas, despesas do mês, total do mês, total do mês anterior e os meses com lançamento |
| `controlai_meus_ids()` | recuperação (lê o e-mail do JWT) |
| `controlai_add_despesa` / `update` / `del` | CRUD da despesa, com as validações de posse e de data futura |
| `controlai_add_categoria` / `update` / `del` | plano de contas (impede subcategoria de subcategoria) |
| `controlai_add_forma` / `update` / `del` | formas de pagamento |
| `controlai_renomear` / `set_email` | ajustes da carteira |
| `controlai_exportar(ledger)` | todas as despesas; o CSV é montado no navegador |

O snapshot de mês em **uma chamada** é deliberado: a tela inteira (total, rosca,
barras, lista, comparação) é desenhada de um JSON só, sem N+1 de rede.

---

## 6. Front

```
js/ui.js       DOM, dinheiro em centavos (parse pt-BR/en-US), datas e meses, toast, CSV download
js/report.js   agregações PURAS: por categoria (com rollup pai/filho), por forma,
               por dia, maiores despesas, série diária, CSV
js/db.js       wrapper das RPCs + fluxo de Auth da recuperação
js/app.js      rotas (#/ · #/c/<uuid> · #/recuperar), telas e formulários
```

`report.js` e os helpers de `ui.js` são puros e cobertos por `tests/unit.mjs`
(**108 verificações**): conversão de valor, aritmética de meses (virada de ano,
bissexto), rollup de subcategoria, despesa órfã que não some do total, ida e
volta de formatação.

**Rollup pai/filho:** o relatório soma a subcategoria no pai e só mostra o
detalhamento quando o valor do pai vem de mais de uma origem — categoria folha
não ganha uma linha redundante repetindo a si mesma.

---

## 7. Verificação feita

- `npm test` — 108/108.
- RPCs testadas via REST com a publishable key (criar, lançar com e sem forma de
  pagamento, snapshot, validações de valor zero, data futura, categoria de outra
  carteira, e-mail inválido, carteira inexistente).
- Segurança: leitura direta das tabelas recusada nas duas formas (schema público
  e `Accept-Profile`); `controlai_meus_ids()` recusado sem sessão.
- Regressão do Rachaí: `get_event()` responde normalmente e as tabelas dele
  continuam bloqueadas.
- Navegador (Playwright, viewport de celular): criar carteira, lançar despesa,
  aba Mês com rosca/KPIs/barras, aba Despesas agrupada por dia, criar
  subcategoria, tela de recuperação. Zero erro no console.

## 8. O que ficou fora da v1

Orçamento/meta por categoria, despesa recorrente, receitas (o app é só de
despesa), múltiplas moedas e anexo de comprovante. O modelo comporta todos —
nenhum exigiria migração destrutiva.
