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

controlai.ledger_email    todo e-mail já registrado na carteira
  (ledger_id, email) pk   ← trocar o e-mail não tira a recuperação do dono

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
4. **Validação de posse dentro da função.** Toda mutação recebe o id da
   **carteira** além do id do objeto e confere o vínculo (`controlai._pertence`).
   Conhecer o uuid de uma despesa ou categoria solta não permite alterá-la nem
   apagá-la — verificado: a carteira B recebe *"Este registro não é desta
   carteira."* ao tentar apagar despesa da carteira A.
5. **`EXECUTE` revogado de `PUBLIC`.** No Postgres a função nasce aberta para
   `PUBLIC`; o grant para `anon` não tirava isso. Agora só `anon` e
   `authenticated` executam, e `search_path` é fixo com `pg_temp` em todas.
6. **Revogação do link.** `controlai_rotacionar_id` troca o uuid (cascata leva
   despesas e categorias junto) — é a única forma de derrubar um link vazado.

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
| `controlai_renomear` / `set_email` | ajustes da carteira (o e-mail antigo continua valendo) |
| `controlai_rotacionar_id(ledger)` | troca o uuid: a única revogação possível de um link vazado |
| `controlai_apagar(ledger, confirmacao)` | exclusão self-service, com o id repetido como confirmação |
| `controlai_exportar(ledger)` | todas as despesas; o CSV é montado no navegador |
| `controlai_analytics_summary(dias)` | uso do app (service_role); `analytics_summary` voltou a contar só o Rachaí |

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
- Navegador (Playwright, viewport de celular), local e **na URL pública**: criar
  carteira, folha de boas-vindas com o link, lançar despesa, criar categoria de
  dentro do formulário sem perder o que foi digitado, aba Mês com rosca/KPIs/
  barras, aba Despesas agrupada por dia, subcategoria, navegação entre meses com
  comparação, tela de recuperação e exclusão da carteira. Zero erro no console.
- Rotação de id e exclusão testadas ponta a ponta (link antigo deixa de abrir,
  dados preservados na rotação; cascata limpa tudo na exclusão).

### O que NÃO foi verificado
O **recebimento do e-mail de recuperação**. Falta um passo no painel do Supabase
(Redirect URLs) que exige acesso de dono, e não há caixa de entrada disponível
aqui para abrir o link. A lógica foi conferida (a RPC recusa sem sessão e lê o
e-mail do JWT), mas o ciclo "pedi o link → abri o e-mail → voltei autenticado"
continua por testar.

## 8. Achados da revisão adversarial e o que mudou

Duas rodadas de revisão por agentes independentes (segurança, front, números, UX,
aderência ao pedido) com verificação cética de cada achado. O que virou correção:

| Achado | Correção |
|---|---|
| Mutação aceitava só o id do objeto | toda RPC passou a exigir o id da carteira |
| Link mágico nunca autenticava (o boot apagava o token da URL antes do supabase-js lê-lo) | o boot espera a sessão resolver |
| `EXECUTE` estava aberto para `PUBLIC` | revogado; só `anon`/`authenticated` |
| Trocar o e-mail sequestrava a recuperação | histórico `ledger_email`: o antigo continua valendo |
| Link nunca era entregue depois de criar | folha de boas-vindas com link, cópia e teste de recuperação |
| Botão de salvar ~600px abaixo do valor no celular | rodapé grudado no sheet |
| Modal sobrevivia à troca de rota | `router()` fecha as folhas |
| Resposta lenta vencia a mais recente | número de sequência por requisição |
| Mês trocava antes da resposta chegar | o mês só vale no sucesso |
| Projeção multiplicava o aluguel do dia 1 | só a partir do 7º dia |
| Percentuais somavam 101% | maior resto, fecham 100 |
| `hojeISO` usava o fuso do aparelho | `America/Sao_Paulo`, igual ao banco |
| Analytics inflava os números do Rachaí | relatórios separados |
| Erro do e-mail (`otp_expired`) caía sem explicação | mensagem real na tela |
| `＋ nova` categoria descartava o formulário | modal por cima, já seleciona a nova |
| Sem `role=dialog`, Esc, foco, rótulos, `aria-pressed` | tudo adicionado |
| `schema.sql` não migrava FK em banco existente | bloco `ALTER` idempotente |

## 9. O que ficou fora da v1

Orçamento/meta por categoria, despesa recorrente, receitas (o app é só de
despesa), múltiplas moedas e anexo de comprovante. O modelo comporta todos —
nenhum exigiria migração destrutiva.
