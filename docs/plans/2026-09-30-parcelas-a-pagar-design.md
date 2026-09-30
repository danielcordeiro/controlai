# Parcelados e contas a pagar — desenho

**Data:** 30/09/2026 · **Status:** aprovado para implementação

## Problema

Hoje a despesa fixa é uma regra: a ocorrência de cada mês só vira lançamento
quando o mês chega, e o mês que vem nunca aparece. Não existe "a pagar". O dono
quer atender duas situações:

1. **Parcelado no cartão** — a compra já está feita; as parcelas dos próximos
   meses precisam aparecer, sem nada a confirmar.
2. **Parcelado no boleto** — as parcelas também aparecem, mas cada uma precisa
   ser confirmada como paga; quero ver o que já paguei e o que falta.

## Decisões do dono

| # | Decisão |
|---|---|
| D1 | A 1ª parcela do cartão cai no mês da compra. Sem dia de fechamento. |
| D2 | Mês futuro mostra "Já comprometido: R$ X" **separado** do gasto. "Gastei" é só o que já aconteceu. |
| D3 | Parcela a pagar **conta** como gasto do mês de vencimento, com selo "a pagar". |
| D4 | Pago/a pagar existe em **fixas e parcelados**. Cada série diz se nasce paga ou pede confirmação. Avulsa é sempre paga. |
| D5 | **Sem** pagar adiantado nem quitar nesta versão. Paga-se quando o mês chega; quitar = cancelar a série, excluir as parcelas a pagar que a quitação cobre e lançar a quitação como avulsa. |
| D6 | A ocorrência carrega o **dia da série** (15/10, 15/11...), cartão e boleto. |
| D7 | "Preciso confirmar o pagamento" vem **desmarcado** por padrão; a pessoa marca. |

## Como chegamos aqui

Três arquiteturas desenhadas de forma independente e julgadas por um revisor
adversarial que conferiu cada afirmação no código: **regra + projeção** (39/50),
**parcelas gravadas de uma vez** (30/50) e **menor diff** (36/50). Gravar as N
parcelas no ato perdia pagamentos ao excluir a regra, desfazia ajustes a cada
edição da série e migraria fixas de outras carteiras. O desenho final passou
por uma segunda rodada de três revisores (SQL, produto, excesso/completude);
os achados estão incorporados abaixo.

## Arquitetura: regra + projeção

- **O futuro é calculado, nunca gravado.** Um mês futuro lê as regras e devolve
  linhas *previstas* (mesmo formato de uma despesa, sem id). Invariante:
  **nenhuma linha de série existe depois do mês corrente.** (Avulsa continua
  aceitando hoje+1, então o mês que vem pode ter linha real no último dia do
  mês — a tela de mês futuro mostra as duas coisas.)
- **O status é um fato da linha:** `expense.a_pagar`. A série só decide com que
  status a ocorrência nasce.
- **Parcelado é fixa finita.** `total_meses = N` já é "10 vezes". O rótulo
  `3/10` é calculado.

## Regras

### Uma fonte para "que ocorrências a regra tem"

`controlai._ocorrencias(ledger, de, ate)` é a **única** definição de quais
ocorrências as regras de uma carteira têm num intervalo de meses. Consumidores:
`_gerar_fixas` (o único INSERT de ocorrência, continua recusando mês futuro),
as previstas do `controlai_mes`, o andamento de cada série, e as leituras da IA
(`api_resumo`, `api_listar`, `api_contas_a_pagar`).

### Como a ocorrência nasce

- `spent_on` = dia da série grampeado no último dia do mês (D6). Sai o
  `least(v_data, hoje)`. O total do mês não muda em relação a hoje: a ocorrência
  já contava desde o dia 1, só que com a data de hoje.
- `a_pagar = confirmar and vencimento >= data de criação da série`. Ocorrência
  que venceu **antes** de a série ser cadastrada é histórico: nasce paga. Isso
  resolve o parcelamento cadastrado em andamento, inclusive a parcela do mês
  corrente que já venceu, e continua certo em qualquer catch-up posterior
  (inclusive além do teto de 240 meses). Se não pagou, "Voltar para a pagar".
- Catch-up depois de meses sem abrir o app: as ocorrências a confirmar desses
  meses nascem a pagar e aparecem atrasadas. É o certo — o app não sabe se
  foram pagas.

### Valor total e centavos

`recurring.total_cents` guarda o total quando a pessoa informa "R$ 1.000 em 3x".
O **servidor** divide: `amount_cents = total_cents / total_meses` (inteira); a
parcela 1 recebe o resto (333,34 + 333,33 + 333,33). O check prende a
coerência: `total_cents - amount_cents * total_meses between 0 and total_meses - 1`.
Mudar valor ou N na edição zera `total_cents`.

### Data das linhas

`controlai._data_ok(nova, antiga, a_pagar)` substitui as quatro cópias de
"não pode ser no futuro":

- data **inalterada** passa (editar o valor da parcela do dia 20 no dia 5 não falha);
- linha **a pagar** não muda de mês: a data dela é o vencimento. Mensagem:
  *"A data da parcela é o vencimento. Para registrar o pagamento, use Marcar como paga."*
  Sem isso, pôr a data em que pagou soltaria a parcela da série (skip no mês
  original, parcela a mais no mês novo);
- o resto continua em `hoje+1`.

### Pagar e desfazer

`controlai_marcar_pago(ledger, expense, pago default true)`: `pago=true` aceita
qualquer linha; `pago=false` só aceita linha que nasceu de série
(`recurring_month is not null`) — avulsa é sempre paga (D4). `del_fixa` passa a
manter `recurring_month` ao soltar as linhas, então uma pendente solta por
exclusão da regra ainda pode ser desmarcada. Data do pagamento não é guardada.

### Andamento de cada série

Sai das linhas e de `_ocorrencias`, nunca de `N × valor` (skip, quitação e
reativação quebrariam a conta):

- `pagas` = linhas da série com `a_pagar = false`;
- `pendentes` / `pendentes_cents` = linhas com `a_pagar = true`;
- `futuras` / `futuras_cents` = `_ocorrencias(mês que vem, último mês da série)`;
  **nulo** em série sem fim;
- falta = pendentes + futuras; "de M" = pagas + pendentes + futuras.

Série sem fim mostra só as pendentes ("1 pendente · R$ 1.500").

### Editar, cancelar, reativar, excluir

- `update_fixa` ganha `p_confirmar default null` (nulo mantém): uma edição de
  valor nunca desliga a confirmação sem ninguém pedir. Reduzir N abaixo da
  maior parcela já lançada é recusado ("use cancelar"). Teto de 600 parcelas
  validado no servidor.
- Cancelar: como hoje; as pendentes continuam pendentes (a dívida não some). O
  texto de confirmação avisa e lembra que parcela coberta por quitação deve ser
  excluída.
- Reativar: como hoje.
- Excluir ganha a opção **"apagar também os lançamentos"** — para quem cadastrou
  errado. Sem ela, recadastrar duplicaria os meses já lançados.
- Excluir UMA parcela a pagar grava skip ("esta não será paga"); o confirm diz:
  *"Se você pagou, use Marcar como paga."*

## Totais

| Número | Definição | Muda? |
|---|---|---|
| Gastei (mês) | `_total_mes`: todas as linhas do mês, pagas e a pagar (D3) | não |
| Pago · A pagar | divisão do gastei por `a_pagar`, no card do total, só quando há a pagar | novo |
| Já comprometido (mês futuro) | soma das previstas; linhas reais do mês (avulsa de hoje+1) aparecem à parte | novo |
| Comparação com o mês anterior | igual; some no mês futuro (na IA, `variacao_pct` nulo) | não |
| Média por dia e projeção | **corrigidas**: só as linhas avulsas são extrapoladas; as de série entram uma vez | bug de hoje |
| Contas a pagar | todas as linhas `a_pagar` da carteira; atrasada = vencimento < hoje | novo |

**Bug que já existe:** `app.js:600-603` extrapola o total inteiro. Uma fixa de
R$ 1.500 no dia 7 vira R$ 6.428 de projeção e R$ 214 "por dia".

## Tela

- **Navegação:** o `›` vai até `max(mês atual, para cada série ativa: último mês
  se finita, senão max(mês de início, mês que vem))`. Sem série, nada muda.
- **Mês futuro** (testado **antes** do retorno "Nenhuma despesa"): card "Já
  comprometido R$ X" com "R$ Y a confirmar"; se houver linha real no mês, "Já
  lançado R$ Z". Rosca e barras sobre previstas + reais. Sem KPIs. Previstas com
  estilo próprio, **não clicáveis**.
- **Mês corrente e passados:** card do total com "Pago R$ X · A pagar R$ Y".
  **Card "A pagar"** (global), visível enquanto houver pendente ou série a
  confirmar ativa: "2 atrasadas · R$ 600" (vermelho), "1 vence este mês ·
  R$ 300", "Próximo: Geladeira 10/10 · R$ 300". O toque abre a folha **Contas a
  pagar**: pendentes por vencimento, atrasadas primeiro, cada uma com "Paguei"
  (a linha fica no lugar como "paga · desfazer" até fechar a folha); "Próximo
  mês" só leitura; e o andamento de cada série a confirmar ("Geladeira — 3 de 10
  pagas · falta R$ 2.100").
- **Lista de despesas:** tags `3/10` (no lugar de `fixa` em série finita),
  `a pagar` (âmbar), `atrasada` (vermelho).
- **Formulário:** "Repetir todo mês" vira "Repetir ou parcelar". Atalhos ganham
  `10x`. Com N finito, chips "o valor é: da parcela | total" e prévia ("10x de
  R$ 300,00 · total R$ 3.000,00"; "1ª R$ 333,34 + 2x R$ 333,33"). Checkbox
  "Preciso confirmar cada pagamento (boleto, carnê)", desmarcado (D7). Com
  repetição ligada a data pode ser futura (1º vencimento no mês que vem).
- **Edição de linha:** "Marcar como paga" / "Voltar para a pagar"; ao lado da
  data de uma linha a pagar, a frase do vencimento.
- **Ajustes → "Fixas e parceladas":** andamento, tag "confirma pagamento",
  checkbox no editar, e a opção de excluir com os lançamentos.
- **Textos que hoje mentiriam** ("nunca adianta o futuro", "Só aparece quando o
  mês chega", "sem oferecer mês futuro"): reescritos em `app.js`, `index.ts`,
  `README.md` e `docs/arquitetura.md`.

## Conector de IA

- `criar_fixa` ganha `confirmar` e `valor_total`; `valor` deixa de ser
  obrigatório (exatamente um dos dois).
- Novo **`lancar_parcelado`** (mesma RPC, `parcelas` obrigatório, mínimo 2):
  sem ele o modelo resolve "10x" com um lançamento do total ou dez lançamentos.
- `editar_fixa` ganha `confirmar`.
- Novo **`marcar_pago`** (`id`, `pago`).
- Novo **`contas_a_pagar`**: atrasadas, vencem este mês, próximas, séries com
  andamento.
- `listar_despesas` ganha `a_pagar`, `parcela` e, em mês futuro, as previstas
  (`prevista: true`, sem id). `resumo_do_mes` ganha `pago`, `a_pagar`,
  `comprometido`. `listar_fixas` ganha `confirmar`, `valor_total` e andamento.
- Instruções: parcelado é `lancar_parcelado` (pergunte em quantas vezes se não
  disseram); boleto/carnê usam `confirmar=true`; "paguei X" = `contas_a_pagar`
  + `marcar_pago`; quitar = `cancelar_fixa` + apagar as pendentes cobertas +
  `lancar_despesa`. Versão 1.3.0.
- O bloco REST da aba IA (`montaPromptIA`) ganha criar_fixa, marcar_pago e
  contas_a_pagar.

## Segurança

RPCs novas `SECURITY DEFINER`, `search_path` fixo com `pg_temp`, `_ledger_ok` +
`_pertence` antes de tudo, `ledger_id` em todo UPDATE/DELETE. Internas novas com
`revoke all`. O laço de `revoke ... from public` do `fixas.sql` passa de
`controlai\_%fixa%` para `controlai\_%` (senão `controlai_marcar_pago` ficaria
executável por PUBLIC), e o `grant` explícito é atualizado com as assinaturas
novas. Assinaturas que mudam levam `drop function if exists` da antiga.

## Deploy

Ordem: **SQL → Edge Function → front.** Todo parâmetro novo tem default, então o
front e a Edge antigos continuam funcionando com o SQL novo.

## O que fica de fora

- Pagar adiantado e quitar (D5). Quando fizer falta, é a única escrita em mês
  futuro e entra por `_gerar_fixas`.
- Data do pagamento (`pago_em`).
- Ajustar UMA parcela futura: ajusta-se quando o mês chega.
- "Marcar todas como pagas" por série.
- Colunas de situação/parcela no Excel/CSV.
- Dia de fechamento do cartão, lembrete de vencimento.

## Verificação

- `tests/unit.mjs`: média por dia e projeção sem inflar com série, divisão em
  parcelas (soma = total), limite da navegação.
- `supabase/checks.sql` (novo): asserts num Postgres descartável — soma das
  parcelas = total; nenhuma linha de série depois do mês corrente; catch-up
  repetido não duplica; cadastro retroativo não gera atraso falso nem marca
  como paga linha de outra série; `update_fixa` sem `p_confirmar` mantém a
  confirmação; andamento certo depois de skip; carteira B não marca linha de A;
  rodar os `.sql` duas vezes.
- Navegador: TV 10x no cartão, geladeira 10x no boleto, ir ao mês que vem,
  marcar paga, desfazer.

---

## Contrato de interfaces

Todos os parâmetros novos vêm **no fim** da assinatura, com default.

### Tabelas (`fixas.sql`)

```sql
alter table controlai.expense   add column if not exists a_pagar boolean not null default false;
alter table controlai.recurring add column if not exists confirmar boolean not null default false;
alter table controlai.recurring add column if not exists total_cents integer;
-- constraint recurring_total_ok (drop if exists + add):
--   total_cents is null or (total_meses is not null
--     and total_cents - amount_cents * total_meses between 0 and total_meses - 1)
```

### Funções internas

| Função | Retorno |
|---|---|
| `controlai._ocorrencias(p_ledger uuid, p_de text, p_ate text)` | `table(recurring_id uuid, mes text, vence date, amount_cents integer, category_id uuid, payment_method_id uuid, description text, confirmar boolean, a_pagar boolean, parcela integer, parcelas integer)` — `parcela`/`parcelas` nulos em série sem fim; skips excluídos |
| `controlai._gerar_fixas(p_ledger uuid, p_mes text)` | `integer` — mesma assinatura; insert-select de `_ocorrencias` |
| `controlai._andamento(p controlai.recurring)` | `table(pagas integer, pendentes integer, pendentes_cents bigint, futuras integer, futuras_cents bigint)` — `futuras*` nulos em série sem fim |
| `controlai._data_ok(p_nova date, p_antiga date default null, p_a_pagar boolean default false)` | `void` (em `schema.sql`) |

### RPCs do app

```
controlai_add_fixa(p_ledger, p_descricao, p_amount_cents, p_category, p_dia,
                   p_mes_inicio, p_total_meses, p_payment_method,
                   p_confirmar boolean default false, p_total_cents integer default null) → uuid
    exatamente um de p_amount_cents / p_total_cents; p_total_cents exige p_total_meses
controlai_update_fixa(p_ledger, p_fixa, p_descricao, p_amount_cents, p_category, p_dia,
                      p_total_meses, p_payment_method, p_confirmar boolean default null) → void
controlai_del_fixa(p_ledger, p_fixa, p_manter_lancamentos boolean default false,
                   p_apagar_lancamentos boolean default false) → void
controlai_marcar_pago(p_ledger uuid, p_expense uuid, p_pago boolean default true) → void
```

### `controlai_mes` — campos novos

```jsonc
{
  "expenses": [{ /* campos de hoje */ "a_pagar": false, "recurring_month": "2026-09",
                 "parcela": 3, "parcelas": 10 }],           // parcela/parcelas nulos fora de série finita
  "fixas": [{ /* campos de hoje, inclusive lancadas e ativa */ "confirmar": true, "total_cents": null,
              "pagas": 3, "pendentes": 1, "pendentes_cents": 30000,
              "futuras": 6, "futuras_cents": 180000 }],     // futuras* nulos em série sem fim
  "previstas": [{ "spent_on": "2026-11-10", "amount_cents": 30000, "category_id": "…",
                  "payment_method_id": "…", "description": "Geladeira",
                  "recurring_id": "…", "recurring_month": "2026-11", "a_pagar": true,
                  "parcela": 4, "parcelas": 10, "prevista": true }],  // só quando mes > mês atual; senão []
  "pendentes": [{ "id": "…", "spent_on": "2026-09-10", "amount_cents": 30000, "description": "…",
                  "category_id": "…", "recurring_id": "…", "recurring_month": "2026-09",
                  "parcela": 3, "parcelas": 10 }],          // todas as a_pagar da carteira, por vencimento, até 200
  "proximas": [ /* formato de previstas: ocorrências a confirmar do mês que vem */ ]
}
```

### RPCs da IA (`api-ia.sql`)

```
controlai_api_criar_fixa(p_token, p_valor numeric default null, p_categoria text default null,
    p_dia, p_meses, p_forma, p_descricao, p_mes_inicio,
    p_confirmar boolean default false, p_valor_total numeric default null) → json
controlai_api_editar_fixa(... assinatura atual ..., p_confirmar boolean default null) → json
controlai_api_marcar_pago(p_token, p_id uuid, p_pago boolean default true) → json
controlai_api_contas_a_pagar(p_token) → json
    { hoje, total_atrasado, total_este_mes,
      atrasadas: [{id, descricao, categoria, vencimento, valor, parcela: "3/10"}],
      vencem_este_mes: [...], proximas: [{descricao, vencimento, valor, parcela}],
      series: [{fixa_id, descricao, pagas, pendentes, restantes, falta}] }   -- falta nulo em série sem fim
controlai_api_resumo  → + pago, a_pagar, comprometido, comprometido_a_confirmar;
                        mês futuro: total_mes_anterior e variacao_pct nulos
controlai_api_listar  → itens + a_pagar, parcela ("3/10"); mês futuro inclui previstas (prevista: true, id nulo)
controlai_api_listar_fixas → + confirmar, valor_total, pagas, pendentes, restantes, falta
```
