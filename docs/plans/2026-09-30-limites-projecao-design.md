# Limite do mês e projeção — desenho (1.4.0)

**Data:** 30/09/2026 · **Status:** aprovado para implementação

## Problema

O dono quer uma projeção de gasto e um limite para o mês inteiro ou para cada
categoria do plano de contas. O perfil real dele: 16 categorias de 1º nível,
24 séries que somam cerca de R$ 17 mil por mês já comprometidos, e as despesas
do dia a dia só começando a ser lançadas, ou seja, quase sem histórico.

## Decisões do dono

| # | Decisão |
|---|---|
| L1 | O limite, total e por categoria, **conta tudo** o que entra no "Total do mês": pagas e a pagar, avulsas e de série. No mês futuro conta o comprometido mais o que já foi lançado. |
| L2 | **Vigência mensal.** Mudar o limite vale do mês atual em diante; cada mês passado guarda o limite que tinha. |
| L3 | **Sem projeção por categoria.** Por categoria o app mostra gasto, livre, "até R$ X/dia" e "passou". A projeção existe só no total. Revisitar quando houver três meses fechados de avulsas (jan/2027). |
| L4 | **Sem limite para um mês futuro específico**, como dezembro ou mês de viagem. Todo limite vale do mês atual em diante. A tabela já tem vigência, então isso entra depois sem migração. |
| L5 | A edição fica numa **folha "Limites"** única, aberta pela aba Mês, com o valor de fixas e parcelas de cada categoria ao lado do campo. |

## Como chegamos aqui

Três propostas independentes, cada uma de um ângulo: o mínimo útil, o uso
diário e a corretude do cálculo. Um juiz as comparou, conferiu cada premissa no
código e escolheu o "mínimo útil" como base, com enxertos das outras duas. A
mudança principal na base foi levar o cálculo para **uma função SQL só**.
Mantê-lo em JavaScript para o app e em SQL para a IA repetiria o problema que a
§10c da arquitetura eliminou: a mesma regra em duas versões.

## Premissas conferidas no código

- `_gerar_fixas` grava **todas** as ocorrências do mês corrente no primeiro
  catch-up, com `spent_on = vence`, mesmo as que vencem no fim do mês
  (`fixas.sql`, `_gerar_fixas`). Por isso, no mês corrente, fixas e parcelas já
  estão no gasto desde o dia 1, e o "livre" é de fato o que sobra para o dia a dia.
- `_ocorrencias(ledger, M, M)` também devolve os meses corrente e passado. Só
  vale somar previstas quando `M >` mês de hoje; nos demais, contaria em dobro.
- O filtro do conector deixa passar o `0`: "false e 0 são valores"
  (`index.ts`, `executaFerramenta`). Portanto `valor: 0` basta para remover um
  limite.
- A busca exata de `_categoria_por_nome` usa `limit 1` sem `order by`
  (`api-ia.sql`). Quando uma categoria e uma subcategoria têm o mesmo nome, ela
  pega qualquer uma. É um bug real de uma linha e entra nesta versão.
- A produção roda Postgres 17.6 (conferido), então `unique nulls not distinct`
  está disponível.

## Regras

### O que é um alvo

- **Total do mês:** um por carteira, `category_id` nulo.
- **Categoria de 1º nível:** o gasto das subcategorias soma no pai pela mesma
  regra `coalesce(parent_id, id)` de `porCategoria` e do `api_resumo`.
  **Subcategoria não aceita limite.**
- Os limites são independentes: nada verifica se a soma das categorias cabe no
  total.
- O limite **nunca bloqueia** um lançamento; ele só informa.

### O que conta contra o limite (L1)

- **Mês corrente e passado:** `gasto` é a soma de todas as linhas com
  `spent_on` no mês, pagas e a pagar, avulsas e de série. No total, é
  exatamente o `_total_mes`.
- **Mês futuro:** `gasto + previsto`. O `previsto` é a soma de
  `_ocorrencias(M, M)` e o `gasto` são as linhas reais já lançadas no mês.
- A parcela atrasada conta no mês do vencimento (D3 do desenho anterior). A
  ocorrência apagada, que vira skip, não conta.

### Vigência (L2, L4)

- Toda gravação usa `mes_inicio = _mes_atual()`.
- O limite do mês M é o da linha com o maior `mes_inicio <= M`.
- **Remover** grava `limite_cents = null`, como tombstone. Apagar a linha faria o
  limite do mês anterior voltar a valer.
- Mudar o limite várias vezes no mesmo mês é upsert. Como nunca existe linha com
  `mes_inicio` no futuro, nunca é preciso apagar nada.
- O filtro `limite_cents is not null` vem **depois** do `distinct on`. Se viesse
  antes, o tombstone sumiria e o limite removido voltaria a valer.
- Mês anterior ao primeiro limite não tem limite. Mês futuro usa o limite
  vigente hoje.

### Números de cada alvo (centavos; somas em bigint)

- `D` é o número de dias do mês M e `d` é o dia de `p_hoje`.
- `livre = limite − gasto − previsto`. O `previsto` é 0 fora do mês futuro.
  Livre negativo significa que o alvo passou do limite, com comparação inteira
  `livre < 0`: chegar exatamente no limite não é passar.
- `livre_dia = floor(greatest(livre, 0) / (D − d + 1))`. Só existe no mês
  corrente e quando o alvo tem limite; nos outros casos é null.
- O percentual exibido é `floor(consumo × 100 / limite)`, com
  `consumo = gasto + previsto`. A barra usa `min(%, 100)`.

### Projeção e média por dia (L3): só na linha do total

A regra é a atual de `ritmoDoMes`, sem mudar o número:

- `S` é a soma das linhas com `recurring_id` ou `recurring_month` preenchido, e
  `A = gasto − S`.
- `projecao = S + round(A × D / d)`. Só no mês corrente e só quando `d ≥ 7`; nos
  outros casos é null.
- `vai_passar = projecao > limite`, quando os dois existem.
- `media_dia`:
  - no mês corrente, `round((S + A × D / d) / D)`;
  - no mês passado, `round(gasto / D)`;
  - no mês futuro, null.

`ritmoDoMes` **sai do JS**. Os KPIs "por dia" e "projeção do mês" passam a ler a
linha de total do snapshot.

## Tela

Os textos seguem o tempo verbal do mês aberto: corrente, passado
(`state.mes < mês atual`) ou futuro (`ehFuturo()`).

### Card do total

Só muda quando há limite total:

- **Barra em duas partes** sobre o limite: série (ou previsto, no futuro) em
  cinza e o dia a dia na cor da marca. A escala é `max(limite, consumo)`. Assim
  os ~85% já ocupados no dia 1 não parecem alarme.
- **Mês corrente:** "Limite R$ L · livre R$ X · até R$ Y/dia". Se passou,
  "Passou R$ X do limite", com a classe `.apagar__atraso`.
- **Mês corrente com projeção** (a partir do dia 7): "No ritmo atual fecha em
  R$ P · R$ Z acima do limite", em âmbar, ou "… dentro do limite".
- **Mês passado:** "Limite R$ L · ficou R$ X abaixo" ou "passou R$ X".
- **Mês futuro** (card "Já comprometido"): "de R$ L · sobram R$ X para o dia a
  dia" ou "o comprometido já passa R$ X do limite".
- **Sem limite total, no mês corrente:** um link discreto "Definir limite", que
  abre a folha.

### Card "Limites"

Fica abaixo do "A pagar" e só aparece quando alguma categoria tem limite. Entra
também no ramo "Nenhuma despesa" e no mês futuro.

- Uma linha por categoria limitada: nome, "R$ 620 de R$ 800" e a barra de
  consumo sobre o limite (vermelha se passou).
- Linha de detalhe:
  - mês corrente: "livre R$ 180 · até R$ 8/dia" ou "passou R$ 45";
  - mês passado: "ficou R$ X abaixo" ou "passou R$ X";
  - mês futuro: "R$ C comprometidos · sobram R$ X".
- Categoria sem gasto aparece com R$ 0.
- A ordem é: passou primeiro, depois o maior percentual.
- No mês corrente o card tem o botão "Editar", que abre a folha.

### Folha "Limites" (L5)

- Abre **só no mês corrente**. Em outro mês, os pontos de entrada não aparecem.
- **Campo "Total do mês"**, com a dica "Este mês já tem R$ S em fixas e
  parcelas". O S vem das linhas de série do snapshot.
- **Uma linha por categoria de 1º nível** não arquivada, mais as arquivadas que
  têm limite, para dar para remover. Ao lado do campo, "fixas e parcelas R$ s":
  `porCategoria` sobre as linhas de série do mês.
- **Vazio remove.** O valor passa por `parseAmountToCents` e `MAX_CENTAVOS`.
- **Salvar** chama `setLimite` só para o que mudou, em sequência, dentro de
  `acaoUnica`, e depois `recarregar()`.
- **Rodapé:** "Vale de {mês} em diante; meses passados guardam o limite que
  tinham."

### O que não muda

A lista "Onde foi o dinheiro", o formulário de despesa, Ajustes e Categorias.
Não há toast novo.

## Conector de IA

- **Ferramenta nova `definir_limite`**: `{valor: number (obrigatório; 0 remove),
  categoria?: string}`. Sem categoria, é o total.
- **`resumo_do_mes` ganha o bloco aditivo `orcamento`.** O `por_categoria` que já
  existe não muda. A descrição da ferramenta diz: "NUNCA extrapole o total por
  conta própria: fixas e parcelas já estão lançadas desde o dia 1; use
  orcamento.projecao".
- **`lancar_despesa` passa a devolver `limites`**: o total e a categoria-topo
  lançada, só os que têm limite vigente no mês da data. Sem limite, vem `[]`. A
  descrição diz: "se vier `limites`, diga quanto ficou livre".
- **Instruções do servidor:** "quanto ainda posso gastar / vou estourar" é
  `resumo_do_mes.orcamento`; "limite de X para Y" é `definir_limite`.
- **Versão 1.4.0, com 15 ferramentas.** Depois do deploy, o dono precisa
  **reconectar** o conector no claude.ai, que guarda a lista de ferramentas em
  cache (hoje ele mostra 11).

## Segurança

- **`controlai.limite`** tem RLS ligada, nenhuma policy e `revoke all` para
  `anon` e `authenticated`, pelo `revoke ... on all tables` do fim do
  `schema.sql`.
- **`controlai_set_limite`** é SECURITY DEFINER com `search_path` fixo. Faz
  `_ledger_ok` e, havendo categoria, `_pertence`. Entra na lista de `grant`
  explícito do `schema.sql`.
- **As internas `_limites` e `_orcamento`** recebem `revoke all` de `anon`,
  `authenticated` e `public`.
- **`controlai_api_definir_limite`** fica coberta pelo laço de grant de
  `controlai_api_%`.
- **As FKs:**
  - `on update cascade` na carteira, porque `controlai_rotacionar_id` troca o id;
  - `on delete cascade` na carteira, por causa de `controlai_apagar`;
  - `on delete cascade` na categoria, porque `del_categoria` só apaga categoria
    sem histórico.

## Deploy

Mesma ordem da 1.3.0, porque todo parâmetro novo tem default e toda chave nova
é aditiva:

1. `schema.sql`, `fixas.sql` e `api-ia.sql` numa transação só;
2. a Edge Function;
3. o front (`VERSAO = "1.4.0"`);
4. a reconexão do conector no claude.ai.

O front 1.3.0 ignora a chave `orcamento`. O front 1.4.0 **não** pode subir antes
do SQL, porque os KPIs passam a vir do servidor.

## O que fica de fora

| Fora | Por quê / quando |
|---|---|
| Projeção por categoria | Uma compra isolada vira um estouro inventado. O "até R$ X/dia" responde a mesma pergunta com fatos. Revisitar com 3 meses fechados. |
| Estimar as avulsas do mês futuro | Não há histórico. Revisitar com 3 meses fechados. |
| Limite em subcategoria | O dono não tem subcategorias. O modelo aceita, basta relaxar a validação. |
| Limite a partir de um mês futuro | L4. Seria um parâmetro opcional em `set_limite`. |
| Alertas por push ou e-mail, toast no app | O card é o alerta. Na IA, o retorno de `lancar_despesa` cumpre esse papel. |
| Sobra de um mês passando para o outro | Especulativo. |
| Limite por forma de pagamento (fatura) | É outra dimensão. Ninguém pediu. |
| Excluir uma categoria ("Poupar") do total | Vira uma flag por categoria quando incomodar. |
| Limites no Excel/CSV, gráfico histórico | Quando houver meses para comparar. |

## Verificação

- **`supabase/checks.sql`**, bloco novo, com `p_hoje` fixo para nada depender
  da data de hoje:
  - upsert no mesmo mês deixa uma linha só;
  - vigência de M−1 contra M;
  - o tombstone não ressuscita o limite anterior;
  - recusas: subcategoria, outra carteira, zero e negativo pelo app e negativo
    pela IA;
  - `0` pela IA remove;
  - o gasto do total é igual a `_total_mes`;
  - o previsto é 0 nos meses corrente e passado com série ativa, e é igual à soma
    de `_ocorrencias` no futuro;
  - o rollup do pai é igual às filhas mais o lançamento direto no pai;
  - categoria limitada sem gasto aparece com 0;
  - a projeção dá 180000 no dia 7 (150000 de série + 7000 de avulsa) e null no
    dia 6, no mês passado e no futuro;
  - `media_dia` e `livre_dia` com `floor`;
  - `rotacionar_id` leva os limites junto e `del_categoria` leva o limite junto;
  - paridade: `api_resumo.orcamento` × 100 é igual a `controlai_mes.orcamento`;
  - `lancar` devolve `limites`;
  - a busca exata de `_categoria_por_nome` prefere o 1º nível.
- **`tests/unit.mjs`**:
  - os testes de `ritmoDoMes` saem, porque a regra virou check SQL;
  - entram testes da função pura das linhas de limite (ordem, percentual com
    floor, barra limitada a 100, passou).
- **Smoke do front** com o Supabase mockado (Playwright, `page.route`) a 390 px,
  sem erro no console:
  - mês corrente com e sem limite;
  - mês passado;
  - mês futuro;
  - folha "Limites".
- **Depois do deploy:** e2e em produção numa carteira descartável, pelo MCP e
  pelo front, apagada no fim.

## Contrato de interfaces

### Tabela (`schema.sql`, logo depois de `controlai.category`)

```sql
create table if not exists controlai.limite (
  ledger_id    uuid not null references controlai.ledger(id) on update cascade on delete cascade,
  category_id  uuid references controlai.category(id) on delete cascade,   -- null = total do mês
  mes_inicio   text not null check (mes_inicio ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  limite_cents integer check (limite_cents > 0),                            -- null = removido deste mês em diante
  unique nulls not distinct (ledger_id, category_id, mes_inicio)
);
create index if not exists limite_categoria_idx on controlai.limite (category_id);
alter table controlai.limite enable row level security;
```

### Funções internas

- `controlai._limites(p_ledger uuid, p_mes text) returns table(category_id uuid,
  limite_cents integer)`:
  - fica em `schema.sql`, depois da tabela; é `language sql stable`;
  - devolve os limites vigentes no mês;
  - faz `distinct on (category_id) … order by category_id, mes_inicio desc`, com
    `mes_inicio <= p_mes`, e só **depois** filtra `limite_cents is not null`.
- `controlai._orcamento(p_ledger uuid, p_mes text, p_hoje date default controlai._hoje())
  returns table(category_id uuid, limite_cents integer, gasto_cents bigint,
  serie_cents bigint, previsto_cents bigint, livre_cents bigint,
  livre_dia_cents bigint, projecao_cents bigint, media_dia_cents bigint)`:
  - fica em `fixas.sql`, depois de `_previstas`, porque é `language sql` e lê
    `_ocorrencias`;
  - é a **única** definição de gasto contra limite, livre, projeção e média;
  - devolve sempre uma linha de total, com `category_id` null e `limite_cents`
    possivelmente null, mais uma linha por categoria de 1º nível com limite
    vigente em `p_mes`, mesmo com gasto 0;
  - "mês corrente" é o mês de `p_hoje`;
  - `projecao_cents` e `media_dia_cents` só vêm na linha do total (null nas de
    categoria);
  - o `gasto` do total inclui todas as linhas do mês e fica igual a
    `_total_mes`.

### RPC do app (`schema.sql`)

- `public.controlai_set_limite(p_ledger uuid, p_category uuid default null,
  p_limite_cents integer default null) returns void`:
  - `_ledger_ok`;
  - com categoria: `_pertence(…, 'category', …)` e `parent_id is null`. Se não
    for, erro "Limite vale para a categoria principal (as subcategorias somam
    nela)." Categoria arquivada é aceita;
  - `p_limite_cents <= 0`: erro "O limite precisa ser maior que zero (vazio
    remove).";
  - grava com `insert … values (ledger, category, _mes_atual(), cents) on
    conflict (ledger_id, category_id, mes_inicio) do update set limite_cents =
    excluded.limite_cents`.

### `controlai_mes`: chave nova (mesma assinatura)

`'orcamento'` é um `json_agg` das linhas de `_orcamento(v_ledger, mes)`, ordenado
com o total primeiro (`category_id nulls first`). Cada item tem as chaves
`category_id`, `limite_cents`, `gasto_cents`, `serie_cents`, `previsto_cents`,
`livre_cents`, `livre_dia_cents`, `projecao_cents` e `media_dia_cents`.

### IA (`api-ia.sql`)

- `public.controlai_api_definir_limite(p_token text, p_valor numeric,
  p_categoria text default null) returns json`:
  - `p_valor` null ou `round(p_valor*100) < 0`: erro "Informe o limite em reais
    (0 remove).";
  - `> 2147483647`: erro "Valor grande demais.";
  - as duas faixas são checadas antes do `::integer`;
  - `v_cents := nullif(round(p_valor*100)::integer, 0)`;
  - a categoria vem de `_categoria_por_nome` quando informada;
  - delega para `controlai_set_limite`;
  - devolve `{ok, categoria (null = total), limite (null = removido),
    a_partir_de: 'AAAA-MM', situacao}`. A `situacao` é o item do alvo no mesmo
    formato de `orcamento`/`categorias` do resumo, ou null.
- `controlai_api_resumo` ganha `'orcamento'`, em reais:
  - `{limite, gasto, fixas_e_parcelas, comprometido, livre, livre_por_dia,
    projecao, media_por_dia, passou, vai_passar, categorias: [...]}`;
  - cada item de `categorias` é `{categoria, limite, gasto, fixas_e_parcelas,
    comprometido, livre, livre_por_dia, passou}`;
  - `fixas_e_parcelas` = `serie`, `comprometido` = `previsto`,
    `passou = livre < 0`, `vai_passar = projecao > limite`;
  - quando não há limite, vêm nulos `limite`, `livre`, `livre_por_dia` e
    `passou`/`vai_passar`.
- `controlai_api_lancar` devolve também `'limites'`:
  `[{alvo: 'total' | nome da categoria-topo, limite, livre, passou}]`, com os
  alvos que têm limite vigente no mês da data. Sem limite, vem `[]`.
- `_categoria_por_nome`: a busca exata ganha `order by c.parent_id is not null,
  c.created_at`.

### Front

- `db.setLimite(ledgerId, categoryId, cents)` chama `controlai_set_limite`.
- `report.js`:
  - `ritmoDoMes` sai;
  - entra uma função pura que monta as linhas do card Limites a partir de
    `s.orcamento` e das categorias (nome, cor, consumo, %, passou, ordem).
- `app.js`:
  - `VERSAO = "1.4.0"`;
  - os KPIs leem a linha de total de `s.orcamento`;
  - cardTotal e abaMesFuturo com o limite;
  - card "Limites" e folha "Limites";
  - `montaPromptIA` com `controlai_api_definir_limite`.
