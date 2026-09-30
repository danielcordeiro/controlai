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
| Analytics | `public.track()` do Rachaí | não vale uma tabela nova; os eventos vão prefixados (`controlai:pageview`) e os relatórios foram separados: `analytics_summary()` exclui `controlai:%` e `controlai_analytics_summary()` só olha para eles |

Nada de dado do Rachaí foi alterado. A única função dele que mudou foi
`analytics_summary()`, que passou a **excluir** os eventos do Controlaí — sem
isso os totais dos dois apps somavam e inflavam o relatório do Rachaí.

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
  recurring_id, recurring_month      ← a série e o mês que geraram a linha (excluir a regra zera só o recurring_id)
  unique (recurring_id, recurring_month) where recurring_id is not null
  a_pagar boolean         ← true = pagamento ainda não confirmado; avulsa é sempre false

controlai.recurring       a despesa fixa ou o parcelado — uma REGRA, não lançamentos futuros
  id, ledger_id
  description, amount_cents, category_id, payment_method_id
  dia integer             ← 1..31; mês sem esse dia usa o último
  mes_inicio text         ← 'AAAA-MM', primeiro mês em que aparece
  total_meses integer     ← null = indeterminado (até cancelar); N = parcelado em N vezes
  cancelado_em text       ← 'AAAA-MM': não gera deste mês em diante
  confirmar boolean       ← a ocorrência nasce a pagar (boleto, carnê)
  total_cents integer     ← o total informado ("R$ 1.000 em 3x"); null = informou a parcela
  check recurring_total_ok: total_cents - amount_cents × total_meses entre 0 e total_meses - 1
  created_at

controlai.recurring_skip  "apaguei a ocorrência deste mês"
  (recurring_id, month_key) pk

controlai.limite          limite do mês, com vigência (seção 10e)
  id, ledger_id           ← id só para a replica identity do update em cascata
  category_id             ← null = total do mês; senão, categoria de 1º nível
  mes_inicio text         ← 'AAAA-MM': vale deste mês até a próxima linha
  limite_cents integer    ← > 0; null = removido deste mês em diante (tombstone)
  unique nulls not distinct (ledger_id, category_id, mes_inicio)
```

**Centavos inteiros** (convenção herdada do Rachaí): nenhum `float` no caminho do
dinheiro, a soma sempre fecha.

**Categoria obrigatória, forma opcional** — exatamente o que o produto pede. A
forma de pagamento é uma dimensão secundária de análise, não um bloqueio no
lançamento.

**Arquivar em vez de excluir**: categoria com histórico não pode ser apagada
(`controlai_del_categoria` recusa e explica). Arquivada, some do formulário e
continua explicando os meses passados.

### Fixa e parcelado: regra + projeção

Parcelado é **fixa finita**: `total_meses = 10` já é "10 vezes", e o rótulo
`3/10` é calculado. A alternativa óbvia — gravar as 12 despesas (ou as 10
parcelas) de uma vez — foi descartada por motivos concretos:

1. **O mês que vem apareceria pré-gasto.** O app existe para responder "quanto
   gastei", e um outubro com R$ 1.500 de aluguel antes de outubro chegar é uma
   resposta errada. O futuro aparece, mas como **"Já comprometido"**, separado
   do gasto.
2. **Corrigir o valor viraria um mutirão.** O aluguel reajusta; com lançamentos
   materializados seria preciso varrer e reescrever cada um — e cada edição da
   série desfaria os ajustes feitos à mão.
3. **"Até eu cancelar" não tem fim** — não existe número de linhas a criar.
4. **Pagamento se perderia.** Com as parcelas gravadas, excluir a regra levaria
   junto o que já foi confirmado como pago.

Então **o futuro é calculado, nunca gravado**. `controlai._ocorrencias(ledger, de,
ate)` é a **única** definição de quais ocorrências as regras de uma carteira têm
num intervalo de meses — vencimento, valor, parcela `3/10` e se nasce a pagar,
com os skips já descontados. Dela saem:

- **a materialização**: `controlai._gerar_fixas(ledger, mes)`, o único INSERT de
  ocorrência, é um insert-select de `_ocorrencias`;
- **a projeção**: as `previstas` de `controlai_mes` (mesmo formato de uma
  despesa, sem id, `prevista: true`), as `proximas` a confirmar, o andamento de
  cada série e as leituras da IA (`api_resumo`, `api_listar`,
  `api_contas_a_pagar`).

**Invariante: nenhuma linha de série existe depois do mês corrente.** A avulsa
continua aceitando hoje+1, então o mês que vem pode ter linha real no último dia
do mês — a tela de mês futuro mostra as duas coisas ("Já comprometido" e "Já
lançado").

`_gerar_fixas`, disparada pelo catch-up (que roda em `controlai_mes`, nas leituras
da IA e ao criar e editar a fixa) e por reativar a fixa:

- **retorna imediatamente se o mês pedido é futuro** — a regra que sustenta o
  invariante;
- é **idempotente**: o índice único `(recurring_id, recurring_month)` garante
  uma ocorrência por série por mês, quantas vezes rodar;
- respeita o **skip**: apagar o lançamento de julho grava `(fixa, '2026-07')` em
  `recurring_skip`, e julho não volta;
- **põe a ocorrência no dia da série** (D6): 15/10, 15/11..., com 31 num mês de
  30 grampeado no dia 30. Antes a data era `least(dia, hoje)`; o total do mês não
  muda, porque a ocorrência já contava desde o dia 1, só que com a data de hoje.

**Pago e a pagar.** O status é um fato da linha, `expense.a_pagar`; a série só
decide com que status a ocorrência nasce: `a_pagar = confirmar and vencimento >=
data de criação da série`. A parcela a pagar **conta** no gasto do mês do
vencimento (D3), com selo. `controlai_marcar_pago` aceita `pago = true` em
qualquer linha e `pago = false` só em linha que nasceu de série
(`recurring_month` preenchido): avulsa é sempre paga (D4). A data do pagamento
não é guardada.

**Criação retroativa.** Ocorrência que venceu **antes** de a série ser cadastrada
é histórico e nasce paga. Isso resolve o parcelamento cadastrado em andamento —
inclusive a parcela do mês corrente que já venceu — sem atraso falso, e continua
certo em qualquer catch-up posterior, inclusive além do teto de 240 meses. Se não
pagou, "Voltar para a pagar". Já o catch-up depois de meses sem abrir o app faz
as ocorrências a confirmar desses meses nascerem a pagar e aparecerem atrasadas:
é o certo, o app não sabe se foram pagas.

**Valor total.** Quem informa "R$ 1.000 em 3x" grava `total_cents`; o
**servidor** divide (`amount_cents = total_cents / total_meses`, inteira) e a
parcela 1 leva o resto: 333,34 + 333,33 + 333,33. O check `recurring_total_ok`
prende a coerência, e mudar valor ou N na edição zera `total_cents`.

**Data das linhas.** `controlai._data_ok(nova, antiga, a_pagar)` substituiu as
quatro cópias de "não pode ser no futuro": data inalterada passa (editar o valor
da parcela do dia 20 no dia 5 não falha); linha a pagar não muda de mês, porque
a data dela é o vencimento — pôr ali a data em que pagou soltaria a parcela da
série, com skip no mês original e parcela a mais no novo; o resto continua em
hoje+1.

**Andamento.** Sai das linhas e de `_ocorrencias`, nunca de N × valor (skip,
quitação e reativação quebrariam a conta): `pagas` e `pendentes` são as linhas da
série por `a_pagar`, `futuras` é `_ocorrencias` do mês que vem até o último mês
da série, recortada nela pelo `p_recurring` — nulo em série sem fim, que mostra
só as pendentes.

Cancelar grava `cancelado_em` = mês que vem, então para de gerar dali em diante
sem apagar nada; as parcelas a pagar continuam pendentes, porque a dívida não
some. **Reativar** não pode simplesmente limpar essa marca: os meses em que a
série esteve parada viram `recurring_skip` antes, senão a próxima abertura do
app faria meses já fechados brotarem com lançamentos que nunca foram pagos.
**Excluir** apaga só a regra e solta as ocorrências: exigir "zero lançamentos"
deixaria o botão inútil para sempre, porque a ocorrência do mês corrente nasce
junto com a série. `recurring_id` vira nulo mas `recurring_month` fica, então
uma pendente solta ainda pode voltar a ser desmarcada. Para quem cadastrou
errado, excluir com **apagar também os lançamentos** leva tudo — sem isso,
recadastrar duplicaria os meses já lançados. Excluir **uma** parcela a pagar
grava skip: "esta não será paga".

Duas armadilhas resolvidas na revisão:

- **Mudar a data de uma ocorrência para outro mês.** O lançamento continuaria
  marcado como "a ocorrência de setembro" estando em agosto: setembro nunca mais
  seria gerado e agosto ficaria com dois. `controlai._solta_da_fixa` desfaz o
  vínculo e marca o mês de origem como pulado. (Linha a pagar nem chega aqui:
  `_data_ok` recusa mudar o mês dela.)
- **Quem só fala com o app pela IA.** A geração era disparada só por
  `controlai_mes`, então o conector respondia o total do mês sem nenhuma fixa,
  e o mesmo mês mudava de valor quando a pessoa abria a tela. Agora
  `controlai._catchup_fixas` roda também em `contexto`, `resumo`, `listar`,
  `listar_fixas` e `contas_a_pagar`, e
  põe em dia todos os meses pendentes de uma vez — `ledger.fixas_ate` guarda até
  onde já foi, para não varrer o histórico a cada abertura.

Na tela, os atalhos `3x/6x/10x/12x/24x/até eu cancelar` cobrem o caso comum e
`outro` abre um campo livre. O campo livre não é luxo: a IA cria fixa com
qualquer número de meses, e sem ele abrir uma fixa de 7 meses para editar não
acenderia chip nenhum — a pessoa não saberia dizer o que está valendo.

O preço dessa escolha: quem não abre o app por três meses só vê os três meses
materializados quando voltar. Como as ocorrências passadas são geradas ao abrir
cada mês, o histórico fica correto de qualquer forma.

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

## 5. API para IA e conector MCP

O app expõe as despesas para uma IA por dois caminhos, ambos autenticados por um
**token próprio da carteira** (`ctl_...`), guardado em `controlai.ledger.api_token`
e **separado do UUID do link**. Rotacionar um não derruba o outro: revogar o
acesso da IA não invalida o seu link, e trocar o link não desconecta a IA.

### Por que uma API separada em vez de reusar as RPCs do app
As RPCs do app falam em `uuid` e centavos. Uma IA recebe *"gastei 62 no mercado"*.
As `controlai_api_*` falam a língua do meio: **valor em reais**, **categoria pelo
nome**, data opcional. O casamento de categoria é sem acento e por prefixo ou
trecho (`alimentacao`, `morad`, e `credito` acha "Cartão de crédito"), e quando
não acha **erra listando as existentes** em vez
de criar uma nova — categoria nascida de erro de digitação some do relatório e
estraga justamente o número que o app existe para mostrar.

| Função | Para quê |
|---|---|
| `controlai_api_contexto` | categorias, subcategorias, formas, hoje e mês atual |
| `controlai_api_lancar` | valor em reais, categoria por nome, data e forma opcionais; devolve `limites` (o total e a categoria lançada, se tiverem limite) |
| `controlai_api_resumo` | total do mês por categoria e por forma, com o mês anterior; `pago` e `a_pagar`; `comprometido` e `comprometido_a_confirmar`; mês futuro sai sem comparação; bloco `orcamento` com limite, livre, projeção e as categorias limitadas |
| `controlai_api_definir_limite` | limite do total ou de uma categoria principal, do mês atual em diante; `0` remove |
| `controlai_api_listar` | lançamentos do mês com id, `a_pagar` e `parcela` (`3/10`); em mês futuro, também as previstas (`prevista: true`, sem id) |
| `controlai_api_editar` / `apagar` | alteram só o que foi informado |
| `controlai_api_criar_fixa` | fixa ou parcelado: `valor` ou `valor_total` (exatamente um), `meses` para um número de repetições ou omitido para "até cancelar", `confirmar` para boleto/carnê |
| `controlai_api_listar_fixas` | as séries com valor, dia, se estão ativas, `confirmar`, `valor_total` e o andamento (`pagas`, `pendentes`, `restantes`, `falta`) |
| `controlai_api_editar_fixa` | muda a série daqui para frente (`ate_cancelar` tira o prazo; `confirmar` omitido mantém) |
| `controlai_api_cancelar_fixa` | para de lançar do mês que vem; o histórico e as pendentes continuam |
| `controlai_api_marcar_pago` | marca a linha como paga ou, se nasceu de série, volta para a pagar |
| `controlai_api_contas_a_pagar` | atrasadas, vencem este mês, próximas a confirmar e o andamento das séries a confirmar (o parcelado no cartão fica em `listar_fixas`) |
| `controlai_api_criar_categoria` | quando a pessoa realmente quer uma nova |
| `controlai_get_api_token` / `rotate_api_token` | chamadas pelo app, recebem o uuid da carteira |

### Conector no claude.ai
GitHub Pages é estático e não hospeda MCP, então o servidor é uma **Supabase Edge
Function** no mesmo projeto: `supabase/functions/controlai-mcp/`. Transporte
Streamable HTTP, JSON-RPC 2.0, respostas JSON diretas (sem SSE — `GET` devolve
405, que é o previsto).

O token vai **no fim da URL** do conector:

```
https://<ref>.supabase.co/functions/v1/controlai-mcp/ctl_xxxxxxxx
```

`verify_jwt` fica **desligado** porque o claude.ai não manda chave do Supabase: a
autenticação é esse token, validado dentro da função pela `controlai._por_token`.
É a mesma chave portadora do link da carteira, e está escrito na tela que a URL
deve ser tratada como senha.

As instruções do servidor dizem explicitamente que gasto que se repete todo mês é
`criar_fixa`, não uma despesa lançada doze vezes — sem isso o modelo tende a
resolver "todo mês pago 1500 de aluguel" com um laço de `lancar_despesa`, que é
justamente o que a seção 3 descarta. Pelo mesmo motivo o parcelado tem
ferramenta própria, `lancar_parcelado`, que chama a mesma
`controlai_api_criar_fixa` com `parcelas` obrigatório: sem ela o modelo resolve
"10x" com um lançamento do total ou com dez. As instruções também dizem que
boleto e carnê levam `confirmar=true`, que "paguei X" é `contas_a_pagar` +
`marcar_pago` e que quitar é `cancelar_fixa` + apagar as pendentes cobertas +
`lancar_despesa`. Na 1.4.0 elas ganharam o limite: "quanto ainda posso gastar" é
`resumo_do_mes.orcamento` e "limite de X para Y" é `definir_limite` (seção 10e).

Erro de ferramenta volta como `isError` com o texto da exceção, não como erro de
protocolo — assim o modelo lê *"Categoria X não existe. Disponíveis: ..."* e se
corrige sozinho em vez de desistir.

## 6. Exportação para Excel

`js/xlsx.js` gera um `.xlsx` **de verdade**, sem dependência: um ZIP (modo
*stored*, que dispensa deflate) com os XMLs do OOXML. CSV continua disponível,
mas deixou de ser o padrão porque no Excel em português ele vira uma coluna só e
o valor entra como texto — não dá para somar nem montar tabela dinâmica.

A planilha sai com data como **data**, valor como **moeda**, cabeçalho congelado,
filtro automático e **categoria e subcategoria em colunas separadas**, que é o
formato que serve para tabela dinâmica.

Os testes não confiam no gerador: eles **abrem o ZIP produzido**, conferem o CRC32
de cada parte e leem o XML da planilha. Fora isso, o `file` do sistema reconhece
o arquivo como *Microsoft Excel 2007+* e o `unzip -t` passa sem erro.

## 7. RPCs

| Função | Para quê |
|---|---|
| `controlai_criar(name, email)` | cria a carteira e **semeia** 10 categorias e 5 formas de pagamento, para a pessoa já sair lançando |
| `controlai_mes(ledger, mes)` | **uma chamada** devolve tudo da tela: carteira, categorias, formas, despesas do mês (com `a_pagar` e `parcela`), fixas com andamento, total do mês, total do mês anterior, os meses com lançamento, as `previstas` de mês futuro, as `pendentes` da carteira, as `proximas` a confirmar e o `orcamento` (linhas de `_orcamento`: o total primeiro, depois as categorias com limite). É também um gatilho do catch-up, que materializa as ocorrências das fixas até o mês corrente |
| `controlai_set_limite(ledger, category, limite_cents)` | grava o limite do total (`category` nula) ou de uma categoria principal, do mês atual em diante; `limite_cents` nulo remove |
| `controlai_meus_ids()` | recuperação (lê o e-mail do JWT) |
| `controlai_add_despesa` / `update` / `del` | CRUD da despesa, com as validações de posse e de data (`_data_ok`) |
| `controlai_marcar_pago(ledger, expense, pago)` | pago ou de volta para a pagar; avulsa não volta, é sempre paga |
| `controlai_add_categoria` / `update` / `del` | plano de contas (impede subcategoria de subcategoria) |
| `controlai_add_forma` / `update` / `del` | formas de pagamento |
| `controlai_add_fixa` / `update_fixa` | cria e edita a fixa ou o parcelado: `p_confirmar`, e `p_total_cents` no lugar do valor da parcela (a edição vale daqui para frente; `p_confirmar` nulo mantém) |
| `controlai_cancelar_fixa` / `reativar_fixa` / `del_fixa` | cancelar para de gerar do mês que vem e mantém as pendentes; reativar não ressuscita o período parado; excluir tira a regra e mantém o histórico, ou leva junto com `p_apagar_lancamentos` |
| `controlai_renomear` / `set_email` | ajustes da carteira (o e-mail antigo continua valendo) |
| `controlai_rotacionar_id(ledger)` | troca o uuid: a única revogação possível de um link vazado |
| `controlai_apagar(ledger, confirmacao)` | exclusão self-service, com o id repetido como confirmação |
| `controlai_exportar(ledger)` | todas as despesas; o CSV é montado no navegador |
| `controlai_analytics_summary(dias)` | uso do app (service_role); `analytics_summary` voltou a contar só o Rachaí |

O snapshot de mês em **uma chamada** é deliberado: a tela inteira (total, rosca,
barras, lista, comparação) é desenhada de um JSON só, sem N+1 de rede.

---

## 8. Front

```
js/ui.js       DOM, dinheiro em centavos (parse pt-BR/en-US), datas e meses, toast, CSV download;
               divideParcelas/previaParcelas (a divisão do servidor, na prévia do
               formulário), limiteNavegacao (até onde o › vai) e limitesDataEdicao
               (a régua de data do servidor no campo de edição)
js/report.js   agregações PURAS: por categoria (com rollup pai/filho), por forma,
               por dia, maiores despesas, CSV; resumoAPagar (o card "A pagar"),
               andamentoFixa ("3 de 10 pagas · falta R$ ..."), linhasLimites (o card
               "Limites") e barraDoTotal (a barra em duas partes do card do total).
               Média, projeção e livre vêm prontos do servidor (seção 10e)
js/db.js       wrapper das RPCs + fluxo de Auth da recuperação
js/xlsx.js     gerador de .xlsx (ZIP stored + OOXML), puro e testado
js/app.js      rotas (#/ · #/c/<uuid> · #/recuperar), telas e formulários
```

`report.js` e os helpers de `ui.js` são puros e cobertos por `tests/unit.mjs`:
conversão de valor, aritmética de meses (virada de ano, bissexto), rollup de
subcategoria, despesa órfã que não some do total, ida e volta de formatação, e
os helpers dos parcelados acima.

**Rollup pai/filho:** o relatório soma a subcategoria no pai e só mostra o
detalhamento quando o valor do pai vem de mais de uma origem — categoria folha
não ganha uma linha redundante repetindo a si mesma.

---

## 9. Verificação feita

- `npm test` — tudo passando; na v1, antes dos parcelados, eram 162 verificações (inclui um leitor de ZIP que confere o CRC32 de cada parte do .xlsx gerado).
- `supabase/checks.sql` — asserts num Postgres 16 descartável, com o SQL aplicado duas vezes.
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
- **Despesas fixas**, no banco: uma fixa de 3 meses começando em junho gerou
  junho, julho e agosto e **parou** — nada em setembro (limite atingido) nem em
  outubro (futuro); dia 31 caiu em 30/06; rodar a geração de novo não duplicou; e
  apagar a ocorrência de julho pelo caminho oficial não a fez voltar.
- **Despesas fixas**, no navegador: criar "Aluguel" de R$ 1.500 no dia 5 "até eu
  cancelar" lançou a ocorrência de setembro na hora, com o selo `fixa` na lista e
  a regra em Ajustes com editar, pausar e excluir.
- **Conector MCP** na v1, então com 10 ferramentas (hoje são 15): `criar_fixa`
  (com número de meses e indeterminada), `listar_fixas` e `cancelar_fixa` por
  `curl` no endpoint publicado; id de outra carteira é recusado.
- **SQL versionado aplicado do zero** num Postgres 16 limpo, na ordem
  `schema.sql → fixas.sql → api-ia.sql`, e depois de novo por cima para conferir
  a idempotência. O teste funcional rodou nesse banco descartável.
- **Paridade repo × produção**, conferida nas fixas, antes dos parcelados: o md5
  do corpo de cada uma das 49 funções (sem comentários nem espaços) bate entre o
  banco criado a partir dos `.sql` versionados e o banco real. O arquivo não é a
  intenção, é o que está rodando.
- **Cenários de fixa conferidos no banco descartável**: mover a ocorrência de
  setembro para agosto solta da série sem duplicar nem deixar buraco; apagar
  pelo conector grava o skip; cancelar em junho e reativar mantém junho e julho
  fora; excluir a regra preserva o lançamento; excluir categoria usada por fixa
  dá mensagem de gente.

### O que NÃO foi verificado
O **recebimento do e-mail de recuperação**. Falta um passo no painel do Supabase
(Redirect URLs) que exige acesso de dono, e não há caixa de entrada disponível
aqui para abrir o link. A lógica foi conferida (a RPC recusa sem sessão e lê o
e-mail do JWT), mas o ciclo "pedi o link → abri o e-mail → voltei autenticado"
continua por testar.

## 10. Achados da revisão adversarial e o que mudou

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

## 10b. Segunda revisão adversarial (despesas fixas)

Cinco revisores por dimensão (SQL, segurança, front, conector, produto) e três
céticos por achado, cada um com uma lente diferente. Sobreviveram e viraram
correção:

| Achado | Correção |
|---|---|
| Editar a data de uma ocorrência para outro mês duplicava o destino e furava a origem para sempre | `controlai._solta_da_fixa` em `update_despesa` e `api_editar` |
| Reativar uma fixa fazia os meses parados nascerem retroativamente | reativar grava `recurring_skip` do período parado antes de limpar `cancelado_em` |
| `resumo` e `listar` da API nunca geravam as fixas: o conector respondia um mês sem elas | `_catchup_fixas` nas três leituras, com marcador `ledger.fixas_ate` |
| Excluir categoria usada só por uma fixa estourava o erro cru de FK | `del_categoria` checa `controlai.recurring` e explica |
| O botão de excluir fixa nunca funcionava: a ocorrência do mês nasce junto com ela | excluir solta os lançamentos e preserva o histórico, com confirmação que diz isso |

Achados menores corrigidos no mesmo passo: `api_apagar` não gravava o skip,
`api_editar` aceitava data futura, o filtro de argumentos do MCP comia `false`,
`cancelar_fixa` aceitava mês malformado, `del_fixa` consultava sem o id da
carteira, `update_fixa` não validava `total_meses`, "faltam N" contava
lançamentos em vez de meses restantes, e o Enter repetido no campo Valor criava
duas fixas iguais.

---

## 10c. Limpeza depois da revisão

Uma terceira passada (reuso, simplificação, eficiência, altitude) trocou remendo
por mecanismo:

- **Uma definição por função.** `fixas.sql` redefinia quatro funções que o
  `schema.sql` já definia — 144 linhas copiadas por causa de uma a três linhas
  de diferença, e rodar `schema.sql` sozinho revertia a feature em silêncio.
  Agora cada função tem um lugar só. Corpo plpgsql não resolve nomes na criação,
  então `schema.sql` pode chamar o que `fixas.sql` cria depois.
- **`controlai._hoje()` e `controlai._mes_atual()`.** O `America/Sao_Paulo`
  tinha virado quatorze expressões iguais; o fuso é constante de negócio e agora
  mora num lugar só.
- **A camada de IA delega.** `controlai_api_criar_fixa` resolve nome→uuid e
  chama `controlai_add_fixa`; `api_cancelar_fixa` chama `controlai_cancelar_fixa`;
  `api_apagar` chama `controlai_del_despesa`. A regra de negócio deixou de existir
  em duas versões que divergiriam na primeira mudança.
- **`acaoUnica(fn)` em `js/ui.js`.** Os formulários ligam o mesmo handler ao
  clique e ao Enter, e `botao.disabled` não protege o caminho do teclado — um
  Enter repetido na tela inicial chegava a criar duas carteiras. A guarda agora
  embrulha os sete handlers, não só o que a revisão pegou.
- **`mesesEntre` em `js/ui.js`**, testada, no lugar de um laço mês a mês dentro
  de `app.js` (com os parcelados, o "faltam N" passou a vir do andamento do
  servidor e a função foi removida); e `seletorRepeticoes` com um estado só,
  sem `NaN` de sentinela.
- **Eficiência**: `_catchup_fixas` sai na primeira leitura quando já está em dia;
  criar fixa não invalida mais o marcador da carteira inteira (passa o mês de
  início); `_gerar_fixas` deixou a pré-checagem redundante para o índice único;
  `controlai_mes` calcula `_fixa_ultimo_mes` uma vez por linha, não três; e as
  FKs novas de `recurring` ganharam índice no lado filho.

---

## 10d. Parcelados e contas a pagar

Desenho completo, com o contrato de interfaces:
[`docs/plans/2026-09-30-parcelas-a-pagar-design.md`](plans/2026-09-30-parcelas-a-pagar-design.md).

Dois casos pedidos: o **parcelado no cartão** (a compra está feita; as parcelas
dos próximos meses precisam aparecer sem nada a confirmar) e o **parcelado no
boleto** (as parcelas aparecem e cada uma é confirmada como paga). Três
arquiteturas foram desenhadas de forma independente e julgadas por um revisor
adversarial que conferiu cada afirmação no código: **regra + projeção** (39/50)
venceu **menor diff** (36/50) e **parcelas gravadas de uma vez** (30/50), que
perdia pagamentos ao excluir a regra, desfazia ajustes a cada edição da série e
migraria fixas de outras carteiras. O desenho final passou por mais três
revisores (SQL, produto, excesso/completude).

| # | Decisão do dono |
|---|---|
| D1 | A 1ª parcela do cartão cai no mês da compra; sem dia de fechamento |
| D2 | Mês futuro mostra "Já comprometido" **separado** do gasto; "gastei" é só o que já aconteceu |
| D3 | Parcela a pagar conta como gasto do mês do vencimento, com selo |
| D4 | Pago/a pagar vale para fixas e parcelados; cada série diz se nasce paga ou pede confirmação; avulsa é sempre paga |
| D5 | Sem pagar adiantado nem quitar; quitar = cancelar a série, excluir as pendentes que a quitação cobre e lançá-la como avulsa |
| D6 | A ocorrência carrega o dia da série, no cartão e no boleto |
| D7 | "Preciso confirmar o pagamento" vem desmarcado |

O mecanismo está na seção 3. O resto:

- **Bug da projeção corrigido.** `app.js` extrapolava o total inteiro do mês:
  uma fixa de R$ 1.500 no dia 7 virava R$ 6.428 de projeção e R$ 214 "por dia".
  Agora a conta mora em `ritmoDoMes` (`report.js`, testada): só as linhas
  avulsas são extrapoladas; as de série entram uma vez. A correção da seção 10
  (projetar só a partir do 7º dia) atenuava o sintoma sem tirar a causa. (Na
  1.4.0 a mesma regra foi para o SQL, em `_orcamento`; veja a seção 10e.)
- **Totais.** "Gastei" não mudou de definição: todas as linhas do mês, pagas e
  a pagar. O card do total ganha "Pago · A pagar"; "Contas a pagar" são todas as
  linhas `a_pagar` da carteira, atrasada quando o vencimento é anterior a hoje;
  no mês futuro a comparação com o mês anterior some (na IA, `variacao_pct`
  nulo).
- **Navegação.** O `›` vai até o último mês das séries ativas (o mês que vem,
  nas que não têm fim); sem série, nada muda.
- **Permissões.** O laço de `revoke ... from public` do `fixas.sql` passou de
  `controlai\_%fixa%` para `controlai\_%` — senão `controlai_marcar_pago`
  ficaria executável por `PUBLIC` — e toda assinatura que mudou leva
  `drop function if exists` da antiga.
- **Deploy em ordem: SQL → Edge Function → front.** Todo parâmetro novo tem
  default, então o front e a Edge antigos continuam funcionando com o SQL novo.
  O SQL vai numa transação só (`psql -1 -v ON_ERROR_STOP=1 -f schema.sql -f
  fixas.sql -f api-ia.sql`, ou os três colados juntos no editor), porque o
  `schema.sql` novo chama o que o `fixas.sql` cria: aplicado sozinho, deixaria o
  app no ar chamando função que ainda não existe.
- **`supabase/checks.sql`.** Asserts das fixas, dos parcelados e das contas a
  pagar, para um Postgres descartável (nunca o Supabase: cria carteiras); tudo
  roda dentro de `begin ... rollback` e não depende da data de hoje. O passo a
  passo está no cabeçalho do arquivo.
- **Desempenho do andamento.** `_ocorrencias` ganhou `p_recurring`: sem ele, o
  andamento de cada série gerava os meses de todas as séries da carteira para
  depois filtrar a dele.
- **Conector 1.3.0**, com 14 ferramentas: `lancar_parcelado`, `marcar_pago` e
  `contas_a_pagar` são novas; `criar_fixa` ganhou `confirmar` e `valor_total`, e
  `editar_fixa`, `confirmar`.

---

## 10e. Limite do mês e projeção (1.4.0)

Desenho completo, com o contrato de interfaces:
[`docs/plans/2026-09-30-limites-projecao-design.md`](plans/2026-09-30-limites-projecao-design.md).

O pedido: um limite para o mês inteiro ou para cada categoria, e uma projeção do
gasto. O perfil real complica as duas coisas: 24 séries somam ~R$ 17 mil já
comprometidos desde o dia 1, e as despesas do dia a dia mal começaram a ser
lançadas, ou seja, quase não há histórico para estimar nada. Três propostas
independentes (mínimo útil, uso diário, corretude do cálculo) foram comparadas
por um juiz que conferiu cada premissa no código; venceu o mínimo útil, com o
cálculo inteiro levado para uma função SQL só.

| # | Decisão do dono |
|---|---|
| L1 | O limite, total e por categoria, **conta tudo** o que entra no "Total do mês": pagas e a pagar, avulsas e de série. No mês futuro conta o comprometido mais o que já foi lançado |
| L2 | **Vigência mensal**: mudar o limite vale do mês atual em diante; cada mês passado guarda o limite que tinha |
| L3 | **Sem projeção por categoria**: por categoria o app mostra gasto, livre, "até R$ X/dia" e "passou"; a projeção existe só no total. Revisitar com três meses fechados de avulsas (jan/2027) |
| L4 | **Sem limite para um mês futuro específico**; todo limite vale do mês atual em diante. A tabela já tem vigência, então isso entra depois sem migração |
| L5 | A edição fica numa **folha "Limites"** única, aberta pela aba Mês, com as fixas e parcelas de cada categoria ao lado do campo |

**Modelo.** `controlai.limite` guarda uma linha por alvo e mês de início: o total
(`category_id` nulo) ou uma categoria de **1º nível** — o gasto das subcategorias
soma no pai pela mesma regra `coalesce(parent_id, id)` do relatório, e
subcategoria não aceita limite. Os limites são independentes (nada confere se a
soma das categorias cabe no total) e **nunca bloqueiam** um lançamento: só
informam.

**Vigência e tombstone.** Toda gravação usa `mes_inicio = _mes_atual()`, e mudar
de novo no mesmo mês é upsert; como nunca existe linha com início no futuro,
nada precisa ser apagado. O limite do mês M é o da linha com o maior
`mes_inicio <= M` (`controlai._limites`). **Remover grava `limite_cents = null`**:
apagar a linha faria o limite do mês anterior voltar a valer. Pelo mesmo motivo o
filtro `limite_cents is not null` vem **depois** do `distinct on` — antes, o
tombstone sumiria e o limite removido ressuscitaria. Mês anterior ao primeiro
limite não tem limite; mês futuro usa o vigente hoje.

**`_orcamento`: a definição única.** `controlai._orcamento(ledger, mes, hoje)`
(em `fixas.sql`, porque lê `_ocorrencias`) é o único lugar que calcula gasto
contra limite, livre, livre por dia, projeção e média. Devolve sempre a linha do
total (com `limite_cents` possivelmente nulo) e uma por categoria com limite
vigente, mesmo sem gasto. O app lê essas linhas em `controlai_mes.orcamento`; a
IA, em `api_resumo.orcamento` (em reais), e a paridade das duas é um check.
Manter a conta em JavaScript para o app e em SQL para a IA repetiria o problema
que a seção 10c eliminou: a mesma regra em duas versões. Por isso `ritmoDoMes`
saiu do `report.js`, e os KPIs "por dia" e "projeção do mês" leem a linha do
total. As regras:

- **gasto** é a soma das linhas do mês, pagas e a pagar, avulsas e de série — no
  total, exatamente `_total_mes`. **previsto** é `_ocorrencias(M, M)` e só entra
  no mês futuro: nos meses corrente e passado as ocorrências já são linhas e
  contariam em dobro. Isso funciona porque `_gerar_fixas` grava todas as
  ocorrências do mês corrente no primeiro catch-up: fixas e parcelas estão no
  gasto desde o dia 1, e o livre é de fato o que sobra para o dia a dia;
- `livre = limite − gasto − previsto`; passou é `livre < 0` (chegar exatamente no
  limite não é passar); `livre_dia = floor(max(livre, 0) / (dias que faltam,
  contando hoje))`, só no mês corrente;
- **projeção** (só no total, só no mês corrente e só a partir do dia 7) é a regra
  de antes, sem mudar o número: `série + round(avulsas × D / d)` — a fixa entra
  uma vez, só a avulsa é extrapolada. `media_dia` é a mesma conta dividida pelos
  dias do mês; no mês passado, gasto ÷ dias;
- percentual exibido com `floor(consumo × 100 / limite)` e a barra parada em 100.

**Tela.** O card do total ganha, quando há limite total, uma barra em duas partes
sobre `max(limite, consumo)`: fixas e parcelas (no futuro, o previsto) numa cor
apagada e o dia a dia em destaque, para os ~85% tomados no dia 1 não parecerem
alarme. O texto segue o tempo do mês: no corrente, "Limite · livre · até R$ Y/dia"
ou "Passou R$ X do limite", mais "No ritmo atual fecha em R$ P" a partir do dia 7
(em âmbar quando passa do limite); no passado, "ficou R$ X abaixo" ou "passou";
no futuro, "sobram R$ X para o dia a dia". O card "Limites" (abaixo do "A pagar",
também no mês vazio e no futuro) tem uma linha por categoria limitada, quem
passou primeiro e depois o maior percentual. A folha "Limites" abre só no mês
corrente — pelo atalho no card do total ("Definir limite" / "Editar limites") ou
pelo "Editar" do card — e salva só o que mudou, uma chamada por vez; vazio remove.

**IA.** `definir_limite {valor, categoria?}` (sem categoria é o total; `0`
remove) chama `controlai_api_definir_limite`, que resolve o nome e delega para
`controlai_set_limite` — a regra não existe em duas versões. `resumo_do_mes`
ganhou o bloco aditivo `orcamento`, e a descrição manda **nunca extrapolar o
total por conta própria**: o modelo, vendo R$ 17 mil no dia 3, multiplicaria por
dez. `lancar_despesa` devolve `limites` (o total e a categoria lançada, só com
limite vigente), e a descrição pede para dizer quanto ficou livre. De brinde,
a busca exata de `_categoria_por_nome` passou a preferir o 1º nível quando uma
categoria e uma subcategoria têm o mesmo nome (antes, `limit 1` sem `order by`).

**Segurança.** `controlai.limite` tem RLS ligada e nenhuma policy;
`controlai_set_limite` é SECURITY DEFINER com `_ledger_ok` e `_pertence`; as
internas `_limites` e `_orcamento` têm o execute revogado. As FKs cascateiam da
carteira (`on update` por causa de `controlai_rotacionar_id`, `on delete` por
`controlai_apagar`) e da categoria (`del_categoria` só apaga categoria sem
histórico, e o limite vai junto).

**Deploy e reconexão.** Mesma ordem da 1.3.0: `schema.sql`, `fixas.sql` e
`api-ia.sql` numa transação só; a Edge Function; o front; e por fim **reconectar
o conector no claude.ai**, que guarda a lista de ferramentas em cache (sem isso
ele continua mostrando as ferramentas antigas e não enxerga `definir_limite`). O
front 1.3.0 ignora a chave `orcamento`, mas o 1.4.0 **não pode** subir antes do
SQL: os KPIs passaram a vir do servidor (sem a chave, "por dia" mostra "-" e a
projeção cai no "maior despesa"). Conector 1.4.0, com 15 ferramentas.

---

## 11. O que ficou fora da v1

Receitas (o app é só de despesa), múltiplas moedas e anexo de comprovante. OAuth no conector MCP também ficou fora: para conector
pessoal o claude.ai aceita servidor sem autenticação, e o token na URL já é o
mesmo nível de segredo do link da carteira. O modelo comporta todos — nenhum
exigiria migração destrutiva.

Dos parcelados (seção 10d), ficaram fora desta versão: **pagar adiantado e
quitar** (D5) — quando fizer falta, é a única escrita em mês futuro e entra por
`_gerar_fixas`; a **data do pagamento** (`pago_em`); ajustar **uma** parcela
futura (ajusta-se quando o mês chega); "marcar todas como pagas" por série;
colunas de situação e parcela no Excel/CSV; dia de fechamento do cartão e
lembrete de vencimento.

Do limite do mês (seção 10e), ficaram fora: **projeção por categoria** (uma
compra isolada vira um estouro inventado; o "até R$ X/dia" responde a mesma
pergunta com fatos) e **estimativa das avulsas do mês futuro** — as duas voltam à
mesa com três meses fechados; **limite em subcategoria** (o modelo aceita, basta
relaxar a validação); **limite a partir de um mês futuro** (L4; seria um
parâmetro opcional em `set_limite`); alertas por push, e-mail ou toast (o card é
o alerta, e na IA o retorno de `lancar_despesa`); sobra de um mês passando para o
outro; limite por forma de pagamento; tirar uma categoria ("Poupar") do total; e
limites no Excel/CSV ou em gráfico histórico.
