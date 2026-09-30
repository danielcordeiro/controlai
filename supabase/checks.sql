-- ============================================================================
-- Controlaí — checks das fixas, parcelados, contas a pagar e limites do mês
--
-- Asserts para um Postgres DESCARTÁVEL (nunca o Supabase: cria carteiras).
-- Tudo roda dentro de begin ... rollback e nada depende da data de hoje: os
-- meses saem de _mes_atual()/_hoje() e _mes_add, e as contas do orçamento
-- (controlai._orcamento) rodam num mês fixo com p_hoje fixo. A primeira falha
-- para tudo com "FALHOU: ..."; no fim sai "checks ok: N".
--
-- Como rodar (Postgres 16 local):
--   1. banco novo:  create database controlai_teste;
--   2. nele, o mínimo do Supabase que os .sql pressupõem:
--        do $$ begin create role anon;          exception when duplicate_object then null; end $$;
--        do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
--        create schema if not exists auth;
--        create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
--   3. psql -v ON_ERROR_STOP=1 -d controlai_teste -f schema.sql -f fixas.sql -f api-ia.sql
--      (duas vezes: rodar de novo por cima não pode quebrar)
--   4. psql -v ON_ERROR_STOP=1 -d controlai_teste -f checks.sql
--   5. drop database controlai_teste;
-- ============================================================================
\set ON_ERROR_STOP 1
begin;

create function pg_temp.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FALHOU: %', p_msg;
  end if;
  perform set_config('checks.n',
    (coalesce(nullif(current_setting('checks.n', true), ''), '0')::integer + 1)::text, true);
end $$;

-- p_sql precisa falhar com uma mensagem que contenha p_trecho
create function pg_temp.falha(p_sql text, p_trecho text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  perform pg_temp.ok(v_msg like '%' || p_trecho || '%',
    format('esperava erro com "%s" em: %s (veio: %s)', p_trecho, p_sql, coalesce(v_msg, 'nenhum erro')));
end $$;

create function pg_temp.carteira() returns uuid language sql as $$
  select (public.controlai_criar('Teste', 'teste@exemplo.com')->>'id')::uuid;
$$;

create function pg_temp.cat(p_ledger uuid, p_nome text) returns uuid language sql as $$
  select id from controlai.category where ledger_id = p_ledger and name = p_nome;
$$;

-- 1. Parcelado no cartão: R$ 1.000 em 3x, a partir deste mês -------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_prox  text := controlai._mes_add(controlai._mes_atual(), 1);
  v_f uuid; r controlai.recurring; j json; x json;
begin
  v_f := public.controlai_add_fixa(v_l, 'TV', null, v_cat, 10, v_atual, 3, null, false, 100000);
  select * into r from controlai.recurring where id = v_f;
  perform pg_temp.ok(r.amount_cents = 33333 and r.total_cents = 100000, 'o servidor divide o total');
  perform pg_temp.ok((select sum(amount_cents) from controlai._ocorrencias(v_l, v_atual, controlai._mes_add(v_atual, 2)))
                     = 100000, 'soma das parcelas = total');
  perform pg_temp.ok((select amount_cents from controlai.expense where recurring_id = v_f) = 33334,
                     'a 1ª parcela leva o resto');
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 1,
                     'só o mês corrente é gravado');
  perform pg_temp.ok(controlai._gerar_fixas(v_l, v_prox) = 0, 'gerar mês futuro não grava nada');
  perform pg_temp.ok(not exists (select 1 from controlai.expense
                                  where ledger_id = v_l and recurring_month > v_atual),
                     'nenhuma linha de série depois do mês corrente');
  perform pg_temp.ok(not exists (select 1 from controlai._ocorrencias(v_l, controlai._mes_add(v_atual, 3),
                                                                      controlai._mes_add(v_atual, 24))),
                     'a série acaba na 3ª parcela');

  -- catch-up repetido, inclusive descendo ao passado, não duplica
  perform controlai._catchup_fixas(v_l);
  perform controlai._catchup_fixas(v_l, controlai._mes_add(v_atual, -6));
  perform controlai._gerar_fixas(v_l, v_atual);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 1,
                     'catch-up repetido não duplica');

  -- mês corrente: a linha traz a_pagar e o rótulo 1/3; nada previsto
  j := public.controlai_mes(v_l, v_atual);
  x := j->'expenses'->0;
  perform pg_temp.ok(not (x->>'a_pagar')::boolean and (x->>'parcela')::int = 1
                     and (x->>'parcelas')::int = 3 and x->>'recurring_month' = v_atual,
                     'expenses: a_pagar, parcela 1/3 e recurring_month');
  perform pg_temp.ok(json_array_length(j->'previstas') = 0, 'mês corrente não tem previstas');
  x := j->'fixas'->0;
  perform pg_temp.ok((x->>'total_cents')::int = 100000 and (x->>'pagas')::int = 1
                     and (x->>'pendentes')::int = 0 and (x->>'futuras')::int = 2
                     and (x->>'futuras_cents')::int = 66666 and not (x->>'confirmar')::boolean,
                     'fixas: andamento do parcelado no cartão');

  -- mês que vem: previstas = _ocorrencias, nenhuma linha gravada
  j := public.controlai_mes(v_l, v_prox);
  perform pg_temp.ok(json_array_length(j->'expenses') = 0, 'mês futuro sem linha de série');
  perform pg_temp.ok(
    json_array_length(j->'previstas') = (select count(*) from controlai._ocorrencias(v_l, v_prox, v_prox))
    and (select sum((p->>'amount_cents')::int) from json_array_elements(j->'previstas') p)
        = (select sum(amount_cents) from controlai._ocorrencias(v_l, v_prox, v_prox)),
    'previstas do mês futuro batem com _ocorrencias');
  x := j->'previstas'->0;
  perform pg_temp.ok((x->>'parcela')::int = 2 and (x->>'amount_cents')::int = 33333
                     and (x->>'prevista')::boolean and x->>'recurring_month' = v_prox
                     and not (x->>'a_pagar')::boolean and x->>'spent_on' = v_prox || '-10',
                     'prevista 2/3 no formato de despesa, no dia da série');
  perform pg_temp.ok(json_array_length(j->'proximas') = 0, 'cartão não gera próximas a confirmar');

  -- editar sem mudar valor nem N mantém o total; mudar o valor zera
  perform public.controlai_update_fixa(v_l, v_f, 'TV 55', 33333, v_cat, 10, 3);
  perform pg_temp.ok((select total_cents from controlai.recurring where id = v_f) = 100000,
                     'editar a descrição mantém o total');
  perform public.controlai_update_fixa(v_l, v_f, 'TV 55', 30000, v_cat, 10, 3);
  perform pg_temp.ok((select total_cents from controlai.recurring where id = v_f) is null,
                     'mudar o valor zera o total');

  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', 100, %L, 1, null, 601)', v_l, v_cat),
                        'entre 1 e 600');
  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', 100, %L, 1, null, 3, null, false, 300)',
                               v_l, v_cat), 'não os dois');
  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', null, %L, 1, null, null, null, false, 300)',
                               v_l, v_cat), 'quantas vezes');
  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', null, %L, 1, null, 3, null, false, 2)',
                               v_l, v_cat), 'R$ 0,01');
  raise notice '1. parcelado no cartão: ok';
end $$;

-- 2. Dia 31, fixa sem fim e data inalterada ----------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_f uuid; v_e uuid; v_e2 uuid; v_d date; j json; x json;
begin
  -- seis meses seguidos sempre incluem um mês de menos de 31 dias
  v_f := public.controlai_add_fixa(v_l, 'Aluguel', 150000, v_cat, 31, controlai._mes_add(v_atual, -5));
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 6,
                     'fixa retroativa lança os 6 meses');
  perform pg_temp.ok(not exists (select 1 from controlai.expense where recurring_id = v_f
                                    and spent_on <> (date_trunc('month', spent_on) + interval '1 month - 1 day')::date),
                     'dia 31 cai no último dia de cada mês');
  perform pg_temp.ok(exists (select 1 from controlai.expense
                              where recurring_id = v_f and extract(day from spent_on) < 31),
                     'algum mês foi grampeado abaixo de 31');
  perform pg_temp.ok(not exists (select 1 from controlai.expense
                                  where recurring_id = v_f and to_char(spent_on, 'YYYY-MM') <> recurring_month),
                     'a data não vaza para o mês seguinte');
  perform pg_temp.ok(not exists (select 1 from controlai._ocorrencias(v_l, controlai._mes_add(v_atual, 1),
                                                                      controlai._mes_add(v_atual, 6)) o
                                  where o.vence <> (date_trunc('month', o.vence) + interval '1 month - 1 day')::date),
                     'previstas também no último dia');

  j := public.controlai_mes(v_l, v_atual);
  x := j->'expenses'->0;
  perform pg_temp.ok(x->>'parcela' is null and x->>'parcelas' is null, 'série sem fim não tem rótulo de parcela');
  x := j->'fixas'->0;
  perform pg_temp.ok((x->>'pagas')::int = 6 and x->>'futuras' is null and x->>'futuras_cents' is null,
                     'série sem fim: futuras nulas');

  -- data inalterada passa mesmo à frente de hoje; para depois dela e de amanhã, não
  select id into v_e from controlai.expense where recurring_id = v_f and recurring_month = v_atual;
  perform public.controlai_update_despesa(v_l, v_e, (select spent_on from controlai.expense where id = v_e),
                                          160000, v_cat);
  perform pg_temp.ok((select amount_cents from controlai.expense where id = v_e) = 160000,
                     'editar o valor com a data inalterada passa');
  perform pg_temp.falha(format('select public.controlai_update_despesa(%L, %L, %L, 1000, %L)',
                               v_l, v_e, (select greatest(spent_on + 1, controlai._hoje() + 2)
                                            from controlai.expense where id = v_e), v_cat), 'futuro');
  perform pg_temp.falha(format('select public.controlai_add_despesa(%L, %L, 1000, %L)',
                               v_l, controlai._hoje() + 2, v_cat), 'futuro');

  -- linha paga já adiante (o dia da série à frente no mês) vem para mais perto,
  -- sem sair do mês. Um mês inteiro depois de amanhã não depende de hoje.
  v_d := (date_trunc('month', controlai._hoje()) + interval '2 months')::date;
  v_e2 := public.controlai_add_despesa(v_l, controlai._hoje(), 1000, v_cat);
  update controlai.expense set spent_on = v_d + 20 where id = v_e2;
  perform public.controlai_update_despesa(v_l, v_e2, v_d + 10, 1000, v_cat);
  perform pg_temp.ok((select spent_on from controlai.expense where id = v_e2) = v_d + 10,
                     'linha adiante vem para mais perto no mesmo mês');
  perform pg_temp.falha(format('select public.controlai_update_despesa(%L, %L, %L, 1000, %L)',
                               v_l, v_e2, v_d + 15, v_cat), 'futuro');
  perform pg_temp.falha(format('select public.controlai_api_editar(%L, %L, p_data => %L)',
                               public.controlai_get_api_token(v_l), v_e2, v_d - 5), 'futuro');
  raise notice '2. dia 31 e fixa sem fim: ok';
end $$;

-- 3. Parcelado a confirmar, cadastro retroativo, pagar e desfazer --------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_l2    uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_ini   text := controlai._mes_add(controlai._mes_atual(), -2);
  v_dia   integer := greatest(extract(day from controlai._hoje())::integer - 1, 1);
  v_a uuid; v_b uuid; v_e0 uuid; v_e1 uuid; v_e2 uuid; v_av uuid; j json; a record;
begin
  -- série A: geladeira 10x no boleto, cadastrada há 4 meses e o app nunca mais
  -- aberto. Nasce no futuro (nada gravado) e vai para o passado por UPDATE.
  v_a := public.controlai_add_fixa(v_l, 'Geladeira', 30000, v_cat, 1, controlai._mes_add(v_atual, 1), 10, null, true);
  perform pg_temp.ok(not exists (select 1 from controlai.expense where recurring_id = v_a),
                     'série que começa no futuro não grava nada');
  update controlai.recurring set mes_inicio = v_ini, created_at = now() - interval '4 months' where id = v_a;
  perform controlai._catchup_fixas(v_l, v_ini);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_a and a_pagar) = 3,
                     'série antiga a confirmar: o catch-up gera os 3 meses a pagar');
  perform pg_temp.ok((select count(*) from controlai.expense
                       where recurring_id = v_a and spent_on < controlai._hoje()) >= 2,
                     'as dos meses passados ficam atrasadas');
  j := public.controlai_mes(v_l, v_atual);
  perform pg_temp.ok(json_array_length(j->'pendentes') = 3 and j->'pendentes'->0->>'recurring_month' = v_ini
                     and (j->'pendentes'->0->>'parcela')::int = 1 and (j->'pendentes'->0->>'parcelas')::int = 10,
                     'pendentes da carteira por vencimento, a 1/10 primeiro');
  perform pg_temp.ok(json_array_length(j->'proximas') = 1 and (j->'proximas'->0->>'parcela')::int = 4
                     and (j->'proximas'->0->>'a_pagar')::boolean,
                     'próximas: a 4/10 vai pedir confirmação no mês que vem');

  -- série B: carnê cadastrado hoje, começando 3 meses atrás, vencendo ontem
  v_b := public.controlai_add_fixa(v_l, 'Carnê', 5000, v_cat, v_dia, controlai._mes_add(v_atual, -3), 12, null, true);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_b) = 4,
                     'cadastro retroativo lança os 4 meses');
  perform pg_temp.ok(not exists (select 1 from controlai.expense
                                  where recurring_id = v_b and a_pagar <> (spent_on >= controlai._hoje())),
                     'retroativo: o que venceu antes do cadastro nasce pago, inclusive no mês corrente');
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_b and not a_pagar) >= 3,
                     'retroativo: os meses passados nascem pagos');
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_a and a_pagar) = 3,
                     'cadastro retroativo não mexe nas pendentes de outra série');

  -- andamento de A depois de pagar uma e pular outra
  select id into v_e2 from controlai.expense where recurring_id = v_a and recurring_month = v_ini;
  select id into v_e1 from controlai.expense where recurring_id = v_a and recurring_month = controlai._mes_add(v_atual, -1);
  select id into v_e0 from controlai.expense where recurring_id = v_a and recurring_month = v_atual;
  perform public.controlai_marcar_pago(v_l, v_e2);
  perform public.controlai_del_despesa(v_l, v_e1);
  perform controlai._catchup_fixas(v_l, v_ini);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_a) = 2,
                     'o mês pulado não volta no catch-up');
  select * into a from controlai._andamento((select r from controlai.recurring r where r.id = v_a));
  perform pg_temp.ok(a.pagas = 1 and a.pendentes = 1 and a.pendentes_cents = 30000
                     and a.futuras = 7 and a.futuras_cents = 210000,
                     format('andamento depois de skip (veio %s/%s/%s/%s/%s)',
                            a.pagas, a.pendentes, a.pendentes_cents, a.futuras, a.futuras_cents));

  -- pagar e desfazer; avulsa não volta para a pagar; carteira B não mexe em A
  perform public.controlai_marcar_pago(v_l, v_e2, false);
  perform pg_temp.ok((select a_pagar from controlai.expense where id = v_e2), 'voltar para a pagar');
  perform public.controlai_marcar_pago(v_l, v_e2, true);
  perform pg_temp.ok(not (select a_pagar from controlai.expense where id = v_e2), 'marcar como paga');
  v_av := public.controlai_add_despesa(v_l, controlai._hoje(), 1000, v_cat);
  perform public.controlai_marcar_pago(v_l, v_av);
  perform pg_temp.ok(not (select a_pagar from controlai.expense where id = v_av), 'marcar avulsa como paga não muda nada');
  perform pg_temp.falha(format('select public.controlai_marcar_pago(%L, %L, false)', v_l, v_av), 'avulsa');
  perform pg_temp.falha(format('select public.controlai_marcar_pago(%L, %L)', v_l2, v_e0), 'não é desta carteira');
  perform pg_temp.ok((select a_pagar from controlai.expense where id = v_e0), 'carteira B não marca linha de A');

  -- linha a pagar não muda de mês, nem pelo app nem pela IA; mesma data passa
  perform pg_temp.falha(format('select public.controlai_update_despesa(%L, %L, %L, 30000, %L)', v_l, v_e0,
                               (select (spent_on - interval '1 month')::date from controlai.expense where id = v_e0),
                               v_cat), 'vencimento');
  perform pg_temp.falha(format('select public.controlai_api_editar(%L, %L, p_data => %L)',
                               public.controlai_get_api_token(v_l), v_e0,
                               (select (spent_on - interval '1 month')::date from controlai.expense where id = v_e0)),
                        'vencimento');
  perform public.controlai_update_despesa(v_l, v_e0, (select spent_on from controlai.expense where id = v_e0),
                                          31000, v_cat);
  perform pg_temp.ok((select amount_cents from controlai.expense where id = v_e0) = 31000,
                     'editar o valor da parcela a pagar com a data inalterada');
  perform public.controlai_update_despesa(v_l, v_e0, (date_trunc('month', controlai._hoje()) + interval '1 month - 1 day')::date,
                                          31000, v_cat);
  perform pg_temp.ok((select recurring_id = v_a and recurring_month = v_atual from controlai.expense where id = v_e0),
                     'o vencimento muda de dia dentro do mês sem soltar da série');

  -- update_fixa sem p_confirmar mantém; N abaixo do que já foi lançado é recusado
  perform public.controlai_update_fixa(v_l, v_a, 'Geladeira', 30000, v_cat, 1, 10, null);
  perform pg_temp.ok((select confirmar from controlai.recurring where id = v_a),
                     'update_fixa sem p_confirmar mantém a confirmação');
  perform pg_temp.falha(format('select public.controlai_update_fixa(%L, %L, ''G'', 30000, %L, 1, 2)', v_l, v_a, v_cat),
                        'use cancelar');
  perform public.controlai_update_fixa(v_l, v_a, 'Geladeira', 30000, v_cat, 1, 3);
  perform pg_temp.ok((select total_meses from controlai.recurring where id = v_a) = 3,
                     'N igual à maior parcela lançada passa');
  perform public.controlai_update_fixa(v_l, v_a, 'Geladeira', 30000, v_cat, 1, 10, null, false);
  perform pg_temp.ok(not (select confirmar from controlai.recurring where id = v_a), 'p_confirmar false desliga');
  perform pg_temp.ok((select a_pagar from controlai.expense where id = v_e0),
                     'desligar a confirmação não mexe nas linhas já lançadas');
  raise notice '3. parcelado a confirmar: ok';
end $$;

-- 4. Excluir a série ----------------------------------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_f uuid; v_e uuid;
begin
  v_f := public.controlai_add_fixa(v_l, 'Errada', 1000, v_cat, 1, controlai._mes_add(v_atual, -2), 6);
  perform pg_temp.falha(format('select public.controlai_del_fixa(%L, %L)', v_l, v_f), 'manter o histórico');
  perform public.controlai_del_fixa(v_l, v_f, false, true);
  perform pg_temp.ok(not exists (select 1 from controlai.recurring where id = v_f)
                     and not exists (select 1 from controlai.expense where ledger_id = v_l),
                     'del_fixa com p_apagar_lancamentos leva as linhas junto');

  -- manter o histórico: a pendente se solta e guarda o mês, então ainda pode ser desmarcada
  v_f := public.controlai_add_fixa(v_l, 'Carnê', 2000, v_cat, 1, v_atual, 5, null, true);
  select id into v_e from controlai.expense where recurring_id = v_f;
  perform public.controlai_marcar_pago(v_l, v_e, false);
  perform public.controlai_del_fixa(v_l, v_f, true);
  perform pg_temp.ok((select recurring_id is null and recurring_month = v_atual and a_pagar
                        from controlai.expense where id = v_e),
                     'del_fixa mantendo: a linha se solta, guarda o mês e continua a pagar');
  perform public.controlai_marcar_pago(v_l, v_e);
  perform public.controlai_marcar_pago(v_l, v_e, false);
  perform pg_temp.ok((select a_pagar from controlai.expense where id = v_e), 'linha solta ainda volta para a pagar');

  -- fora do mês dela, a linha solta vira avulsa e não volta mais para a pagar
  perform public.controlai_marcar_pago(v_l, v_e);
  perform public.controlai_update_despesa(v_l, v_e, (date_trunc('month', controlai._hoje()) - interval '1 day')::date,
                                          2000, v_cat);
  perform pg_temp.ok((select recurring_month is null from controlai.expense where id = v_e),
                     'linha solta que muda de mês perde o recurring_month');
  perform pg_temp.falha(format('select public.controlai_marcar_pago(%L, %L, false)', v_l, v_e), 'avulsa');
  raise notice '4. excluir série: ok';
end $$;

-- 5. Conector de IA -----------------------------------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_t     text := public.controlai_get_api_token(v_l);
  v_atual text := controlai._mes_atual();
  v_prox  text := controlai._mes_add(controlai._mes_atual(), 1);
  v_tv uuid; v_sofa uuid; v_e uuid; j json; x json;
begin
  j := public.controlai_api_criar_fixa(v_t, p_valor_total => 1000, p_categoria => 'Moradia', p_meses => 3,
                                       p_dia => 1, p_descricao => 'TV');
  v_tv := (j->>'id')::uuid;
  perform pg_temp.ok((j->>'valor')::numeric = 333.33 and (j->>'valor_total')::numeric = 1000
                     and (select total_cents from controlai.recurring where id = v_tv) = 100000,
                     'api_criar_fixa com valor_total');
  j := public.controlai_api_criar_fixa(v_t, p_valor => 50, p_categoria => 'Lazer', p_descricao => 'Streaming');
  perform pg_temp.ok((j->>'valor')::numeric = 50 and j->>'valor_total' is null and j->>'repeticoes' = 'até cancelar',
                     'api_criar_fixa com valor');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, p_valor => 10, p_valor_total => 30, '
                               'p_categoria => ''Lazer'', p_meses => 3)', v_t), 'não os dois');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, p_categoria => ''Lazer'')', v_t),
                        'maior que zero');

  -- boleto 5x a confirmar; a 1ª é forçada a pagar para não depender do dia de hoje
  j := public.controlai_api_criar_fixa(v_t, p_valor => 200, p_categoria => 'Moradia', p_meses => 5, p_dia => 1,
                                       p_confirmar => true, p_descricao => 'Sofá');
  v_sofa := (j->>'id')::uuid;
  perform pg_temp.ok((j->>'confirmar')::boolean, 'api_criar_fixa com confirmar');
  select id into v_e from controlai.expense where recurring_id = v_sofa;
  perform public.controlai_marcar_pago(v_l, v_e, false);

  j := public.controlai_api_contas_a_pagar(v_t);
  perform pg_temp.ok(json_array_length(j->'atrasadas') + json_array_length(j->'vencem_este_mes')
                     = (select count(*) from controlai.expense where ledger_id = v_l and a_pagar)
                     and (j->>'total_atrasado')::numeric + (j->>'total_este_mes')::numeric = 200,
                     'contas_a_pagar: atrasadas + vencem este mês = todas as a pagar');
  x := coalesce(j->'atrasadas'->0, j->'vencem_este_mes'->0);
  perform pg_temp.ok((x->>'id')::uuid = v_e and x->>'parcela' = '1/5' and x->>'descricao' = 'Sofá',
                     'contas_a_pagar: a pendente com id e parcela');
  perform pg_temp.ok(json_array_length(j->'proximas') = 1 and j->'proximas'->0->>'parcela' = '2/5',
                     'contas_a_pagar: próximas');
  perform pg_temp.ok(json_array_length(j->'series') = 1 and (j->'series'->0->>'pendentes')::int = 1
                     and (j->'series'->0->>'restantes')::int = 5 and (j->'series'->0->>'falta')::numeric = 1000,
                     'contas_a_pagar: andamento da série a confirmar');
  j := public.controlai_api_marcar_pago(v_t, v_e);
  perform pg_temp.ok(not (j->>'a_pagar')::boolean, 'api_marcar_pago');

  -- mês que vem: as previstas vêm à parte do gasto
  j := public.controlai_api_listar(v_t, v_prox);
  perform pg_temp.ok(json_array_length(j) = (select count(*) from controlai._ocorrencias(v_l, v_prox, v_prox))
                     and (select bool_and((i->>'prevista')::boolean and i->>'id' is null)
                            from json_array_elements(j) i),
                     'api_listar do mês futuro traz as previstas, sem id');
  perform pg_temp.ok((select count(*) from json_array_elements(j) i where i->>'parcela' = '2/3') = 1,
                     'api_listar: rótulo 2/3');
  j := public.controlai_api_resumo(v_t, v_prox);
  perform pg_temp.ok((j->>'total')::numeric = 0 and j->>'total_mes_anterior' is null and j->>'variacao_pct' is null
                     and (j->>'comprometido')::numeric * 100
                         = (select sum(amount_cents) from controlai._ocorrencias(v_l, v_prox, v_prox))
                     and (j->>'comprometido_a_confirmar')::numeric = 200,
                     'api_resumo do mês futuro');
  j := public.controlai_api_resumo(v_t);
  perform pg_temp.ok((j->>'pago')::numeric + (j->>'a_pagar')::numeric = (j->>'total')::numeric
                     and (j->>'comprometido')::numeric = 0 and j->>'total_mes_anterior' is not null,
                     'api_resumo do mês corrente');
  j := public.controlai_api_listar(v_t, v_atual);
  perform pg_temp.ok(json_array_length(j) = 3 and (select bool_and(not (i->>'prevista')::boolean and i->>'id' is not null)
                                                     from json_array_elements(j) i),
                     'api_listar do mês corrente: só linhas reais');

  select f into x from json_array_elements(public.controlai_api_listar_fixas(v_t)) f
   where f->>'id' = v_tv::text;
  perform pg_temp.ok((x->>'valor_total')::numeric = 1000 and not (x->>'confirmar')::boolean
                     and (x->>'pagas')::int = 1 and (x->>'restantes')::int = 2 and (x->>'falta')::numeric = 666.66,
                     'api_listar_fixas com andamento');
  j := public.controlai_api_editar_fixa(v_t, v_tv, p_confirmar => true);
  perform pg_temp.ok((j->>'confirmar')::boolean and (select total_cents from controlai.recurring where id = v_tv) = 100000,
                     'api_editar_fixa liga a confirmação sem mexer no total');

  -- apagar uma parcela a pagar pela IA grava o skip e avisa do marcar_pago
  perform public.controlai_marcar_pago(v_l, v_e, false);
  j := public.controlai_api_apagar(v_t, v_e);
  perform pg_temp.ok(j->>'observacao' like '%marcar_pago%'
                     and exists (select 1 from controlai.recurring_skip
                                  where recurring_id = v_sofa and month_key = v_atual),
                     'api_apagar de parcela a pagar');
  raise notice '5. conector de IA: ok';
end $$;

-- 6. Permissões ---------------------------------------------------------------
do $$
begin
  perform pg_temp.ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'controlai' or (n.nspname = 'public' and p.proname like 'controlai\_%'))
       and has_function_privilege('public', p.oid, 'execute')),
    'nenhuma função do Controlaí executável por PUBLIC');
  perform pg_temp.ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'controlai' and has_function_privilege('anon', p.oid, 'execute')),
    'funções internas fechadas para anon');
  perform pg_temp.ok(
    has_function_privilege('anon', 'public.controlai_marcar_pago(uuid, uuid, boolean)', 'execute')
    and has_function_privilege('anon', 'public.controlai_add_fixa(uuid, text, integer, uuid, integer, text, integer, uuid, boolean, integer)', 'execute')
    and has_function_privilege('anon', 'public.controlai_update_fixa(uuid, uuid, text, integer, uuid, integer, integer, uuid, boolean)', 'execute')
    and has_function_privilege('anon', 'public.controlai_del_fixa(uuid, uuid, boolean, boolean)', 'execute')
    and has_function_privilege('anon', 'public.controlai_api_contas_a_pagar(text)', 'execute')
    and has_function_privilege('anon', 'public.controlai_api_marcar_pago(text, uuid, boolean)', 'execute'),
    'RPCs novas liberadas para anon');
  raise notice '6. permissões: ok';
end $$;

-- 7. Valores no limite do integer ---------------------------------------------
do $$
declare
  v_l    uuid := pg_temp.carteira();
  v_t    text := public.controlai_get_api_token(v_l);
  v_cat  uuid := pg_temp.cat(v_l, 'Moradia');
  v_prox text := controlai._mes_add(controlai._mes_atual(), 1);
  v_f uuid; v_e uuid;
begin
  -- série de antes da trava: parcela × N passa do integer, sem total
  insert into controlai.recurring (ledger_id, amount_cents, category_id, mes_inicio, total_meses)
  values (v_l, 1000000000, v_cat, v_prox, 3) returning id into v_f;
  perform pg_temp.ok((select sum(amount_cents) from controlai._ocorrencias(v_l, v_prox, controlai._mes_add(v_prox, 2)))
                     = 3000000000, '_ocorrencias com parcela × N acima do integer');
  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', 1000000000, %L, 1, %L, 3)',
                               v_l, v_cat, v_prox), 'Valor total grande demais');
  perform pg_temp.falha(format('select public.controlai_update_fixa(%L, %L, ''x'', 1000000000, %L, 1, 3)',
                               v_l, v_f, v_cat), 'Valor total grande demais');
  perform pg_temp.ok(public.controlai_add_fixa(v_l, 'x', 700000000, v_cat, 1, v_prox, 3) is not null,
                     'parcela × N logo abaixo do integer passa');

  -- a IA confere a faixa antes do ::integer: nada de erro cru do Postgres
  v_e := public.controlai_add_despesa(v_l, controlai._hoje(), 1000, v_cat);
  perform pg_temp.falha(format('select public.controlai_api_lancar(%L, 1e20, ''Moradia'')', v_t), 'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_lancar(%L, 21474836.48, ''Moradia'')', v_t),
                        'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_lancar(%L, -1e20, ''Moradia'')', v_t), 'maior que zero');
  perform pg_temp.falha(format('select public.controlai_api_lancar(%L, 0.004, ''Moradia'')', v_t), 'maior que zero');
  perform pg_temp.falha(format('select public.controlai_api_editar(%L, %L, 1e20)', v_t, v_e), 'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_editar(%L, %L, -1e20)', v_t, v_e), 'maior que zero');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, 1e20, ''Moradia'')', v_t),
                        'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, -1e20, ''Moradia'')', v_t),
                        'maior que zero');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, p_valor_total => 1e20, '
                               'p_categoria => ''Moradia'', p_meses => 3)', v_t), 'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_criar_fixa(%L, 10000000, ''Moradia'', p_meses => 3)', v_t),
                        'Valor total grande demais');
  perform pg_temp.falha(format('select public.controlai_api_editar_fixa(%L, %L, 1e20)', v_t, v_f),
                        'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_editar_fixa(%L, %L, -1e20)', v_t, v_f),
                        'maior que zero');
  raise notice '7. valores no limite: ok';
end $$;

-- 8. Andamento recorta a série em _ocorrencias --------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_prox  text := controlai._mes_add(controlai._mes_atual(), 1);
  v_b uuid; v_c uuid;
begin
  perform public.controlai_add_fixa(v_l, 'Sem fim', 1000, v_cat, 5, controlai._mes_add(v_atual, -3));
  v_b := public.controlai_add_fixa(v_l, 'TV', null, v_cat, 31, controlai._mes_add(v_atual, -2), 12, null, false, 100001);
  v_c := public.controlai_add_fixa(v_l, 'Curso', 3000, v_cat, 10, v_atual, 6, null, true);
  insert into controlai.recurring_skip values (v_b, controlai._mes_add(v_atual, 4));
  perform public.controlai_cancelar_fixa(v_l, v_c, controlai._mes_add(v_atual, 3));

  perform pg_temp.ok(not exists (
    select 1 from controlai.recurring r
     cross join lateral controlai._andamento(r) a
      left join lateral (select count(*)::integer as n, coalesce(sum(o.amount_cents), 0)::bigint as c
                           from controlai._ocorrencias(v_l, v_prox, controlai._fixa_ultimo_mes(r)) o
                          where o.recurring_id = r.id
                         having controlai._fixa_ultimo_mes(r) is not null) f on true
     where r.ledger_id = v_l
       and (a.futuras is distinct from f.n or a.futuras_cents is distinct from f.c)),
    'andamento com o recorte por série = sem o recorte');
  perform pg_temp.ok((select string_agg(r.description || '=' || coalesce(a.futuras::text, '-'), ','
                                        order by r.description)
                        from controlai.recurring r cross join lateral controlai._andamento(r) a
                       where r.ledger_id = v_l) = 'Curso=2,Sem fim=-,TV=8',
                     'o teste cobre skip, cancelamento e série sem fim');
  perform pg_temp.ok((select count(*) = 8 and bool_and(o.recurring_id = v_b)
                        from controlai._ocorrencias(v_l, v_prox, controlai._mes_add(v_atual, 24), v_b) o),
                     '_ocorrencias com p_recurring traz só a série pedida');
  perform pg_temp.ok((select prosrc from pg_proc
                       where oid = 'controlai._andamento(controlai.recurring)'::regprocedure)
                     ~ '_fixa_ultimo_mes\(p\), p\.id\)',
                     '_andamento passa a série para _ocorrencias');
  perform pg_temp.ok(to_regprocedure('controlai._ocorrencias(uuid, text, text)') is null,
                     'sem a sobrecarga antiga de _ocorrencias');
  raise notice '8. andamento por série: ok';
end $$;

-- 9. Estender série terminada e início antigo ---------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_cat   uuid := pg_temp.cat(v_l, 'Moradia');
  v_atual text := controlai._mes_atual();
  v_f uuid;
begin
  v_f := public.controlai_add_fixa(v_l, 'Curso', 1000, v_cat, 1, controlai._mes_add(v_atual, -4), 3);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 3
                     and (select fixas_ate from controlai.ledger where id = v_l) = v_atual,
                     'série de 3x já terminada, carteira em dia');
  perform public.controlai_update_fixa(v_l, v_f, 'Curso', 1000, v_cat, 1, 10);
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 5
                     and exists (select 1 from controlai.expense
                                  where recurring_id = v_f and recurring_month = v_atual),
                     'estender a série lança os meses que faltavam, até o corrente');

  perform pg_temp.falha(format('select public.controlai_add_fixa(%L, ''x'', 100, %L, 1, %L)',
                               v_l, v_cat, controlai._mes_add(v_atual, -240)), 'antigo demais');
  v_f := public.controlai_add_fixa(v_l, 'Antiga', 100, v_cat, 1, controlai._mes_add(v_atual, -239));
  perform pg_temp.ok((select count(*) from controlai.expense where recurring_id = v_f) = 240
                     and (select fixas_ate from controlai.ledger where id = v_l) = v_atual,
                     'início no limite: 240 meses num catch-up só, sem rebobinar fixas_ate');
  raise notice '9. estender série e início antigo: ok';
end $$;

-- 10. Limites: gravação, vigência e recusas -----------------------------------
do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_l2    uuid := pg_temp.carteira();
  v_t     text := public.controlai_get_api_token(v_l);
  v_mor   uuid := pg_temp.cat(v_l, 'Moradia');
  v_ali   uuid := pg_temp.cat(v_l, 'Alimentação');
  v_atual text := controlai._mes_atual();
  v_ant   text := controlai._mes_add(controlai._mes_atual(), -1);
  v_sub uuid; v_nova uuid; v_novo uuid; v_n integer; j json;
begin
  v_sub := public.controlai_add_categoria(v_l, 'Aluguel', v_mor);

  -- mudar de novo no mesmo mês é upsert, inclusive no total (category_id nulo)
  perform public.controlai_set_limite(v_l, null, 100000);
  perform public.controlai_set_limite(v_l, null, 120000);
  perform public.controlai_set_limite(v_l, v_mor, 50000);
  perform public.controlai_set_limite(v_l, v_mor, 60000);
  perform pg_temp.ok((select count(*) from controlai.limite where ledger_id = v_l) = 2
                     and (select limite_cents from controlai.limite
                           where ledger_id = v_l and category_id is null and mes_inicio = v_atual) = 120000
                     and (select limite_cents from controlai.limite
                           where ledger_id = v_l and category_id = v_mor and mes_inicio = v_atual) = 60000,
                     'upsert no mesmo mês deixa uma linha por alvo');

  -- vigência: M-1 guarda o seu, M e o futuro usam o de M, antes do primeiro nada
  insert into controlai.limite (ledger_id, category_id, mes_inicio, limite_cents) values (v_l, null, v_ant, 90000), (v_l, v_ali, v_ant, 30000);
  perform pg_temp.ok((select limite_cents from controlai._limites(v_l, v_ant) where category_id is null) = 90000
                     and (select limite_cents from controlai._limites(v_l, v_atual) where category_id is null) = 120000
                     and (select limite_cents from controlai._limites(v_l, controlai._mes_add(v_atual, 5))
                           where category_id is null) = 120000,
                     'vigência: M-1 guarda o limite que tinha; M e o futuro usam o de M');
  perform pg_temp.ok(not exists (select 1 from controlai._limites(v_l, controlai._mes_add(v_atual, -2))),
                     'antes do primeiro limite não há limite');
  perform pg_temp.ok((select limite_cents from controlai._limites(v_l, v_atual) where category_id = v_ali) = 30000,
                     'o limite de M-1 continua valendo em M');

  -- remover grava o tombstone: o de M-1 não volta a valer em M
  perform public.controlai_set_limite(v_l, v_ali, null);
  perform pg_temp.ok(not exists (select 1 from controlai._limites(v_l, v_atual) where category_id = v_ali)
                     and (select limite_cents from controlai._limites(v_l, v_ant) where category_id = v_ali) = 30000
                     and exists (select 1 from controlai.limite where ledger_id = v_l and category_id = v_ali
                                    and mes_inicio = v_atual and limite_cents is null),
                     'o tombstone não ressuscita o limite anterior e o mês passado fica como estava');

  perform pg_temp.falha(format('select public.controlai_set_limite(%L, %L, 1000)', v_l, v_sub), 'categoria principal');
  perform pg_temp.falha(format('select public.controlai_set_limite(%L, %L, 1000)', v_l2, v_mor), 'não é desta carteira');
  perform pg_temp.falha(format('select public.controlai_set_limite(%L, null, 0)', v_l), 'maior que zero');
  perform pg_temp.falha(format('select public.controlai_set_limite(%L, %L, -5)', v_l, v_mor), 'maior que zero');
  perform pg_temp.falha(format('select public.controlai_api_definir_limite(%L, -10)', v_t), '0 remove');
  perform pg_temp.falha(format('select public.controlai_api_definir_limite(%L, null)', v_t), '0 remove');
  perform pg_temp.falha(format('select public.controlai_api_definir_limite(%L, 1e20)', v_t), 'Valor grande demais');
  perform pg_temp.falha(format('select public.controlai_api_definir_limite(%L, 10, ''Aluguel'')', v_t),
                        'categoria principal');
  perform pg_temp.ok((select count(*) from controlai.limite where ledger_id in (v_l, v_l2)) = 5,
                     'as recusas não gravam nada');

  -- categoria arquivada aceita limite, para dar para remover o dela
  perform public.controlai_update_categoria(v_l, v_ali, 'Alimentação', null, true);
  perform public.controlai_set_limite(v_l, v_ali, 40000);
  perform pg_temp.ok((select limite_cents from controlai._limites(v_l, v_atual) where category_id = v_ali) = 40000,
                     'categoria arquivada aceita limite');
  -- e a IA também tira o dela: _categoria_por_nome só acha as ativas
  j := public.controlai_api_definir_limite(v_t, 0, 'alimentacao');
  perform pg_temp.ok(j->>'categoria' = 'Alimentação'
                     and not exists (select 1 from controlai._limites(v_l, v_atual) where category_id = v_ali),
                     'a IA remove o limite de categoria arquivada');

  -- pela IA: categoria pelo nome, 0 remove, sem categoria é o total
  j := public.controlai_api_definir_limite(v_t, 800, 'moradia');
  perform pg_temp.ok(j->>'categoria' = 'Moradia' and (j->>'limite')::numeric = 800 and j->>'a_partir_de' = v_atual
                     and j->'situacao'->>'categoria' = 'Moradia' and (j->'situacao'->>'limite')::numeric = 800
                     and (select limite_cents from controlai._limites(v_l, v_atual) where category_id = v_mor) = 80000,
                     'api_definir_limite pelo nome da categoria, com a situação');
  j := public.controlai_api_definir_limite(v_t, 0, 'Moradia');
  perform pg_temp.ok((j->>'ok')::boolean and j->>'limite' is null and j->>'situacao' is null
                     and not exists (select 1 from controlai._limites(v_l, v_atual) where category_id = v_mor),
                     '0 pela IA remove');
  j := public.controlai_api_definir_limite(v_t, 1500.5);
  perform pg_temp.ok(j->>'categoria' is null and (j->'situacao'->>'limite')::numeric = 1500.5
                     and (select limite_cents from controlai._limites(v_l, v_atual) where category_id is null) = 150050,
                     'sem categoria, a IA define o total');

  -- rotacionar o id leva os limites; excluir a categoria e apagar a carteira também
  select count(*) into v_n from controlai.limite where ledger_id = v_l;
  v_novo := public.controlai_rotacionar_id(v_l);
  perform pg_temp.ok(v_n > 0 and (select count(*) from controlai.limite where ledger_id = v_novo) = v_n
                     and not exists (select 1 from controlai.limite where ledger_id = v_l),
                     'rotacionar_id leva os limites junto');
  v_nova := public.controlai_add_categoria(v_novo, 'Viagem');
  perform public.controlai_set_limite(v_novo, v_nova, 1000);
  perform public.controlai_del_categoria(v_novo, v_nova);
  perform pg_temp.ok(not exists (select 1 from controlai.limite where category_id = v_nova),
                     'del_categoria leva o limite junto');
  perform public.controlai_apagar(v_novo, v_novo);
  perform pg_temp.ok(not exists (select 1 from controlai.limite where ledger_id = v_novo),
                     'apagar a carteira leva os limites');

  perform pg_temp.ok(has_function_privilege('anon', 'public.controlai_set_limite(uuid, uuid, integer)', 'execute')
                     and has_function_privilege('anon', 'public.controlai_api_definir_limite(text, numeric, text)', 'execute')
                     and not has_function_privilege('anon', 'controlai._limites(uuid, text)', 'execute')
                     and not has_function_privilege('anon', 'controlai._orcamento(uuid, text, date)', 'execute')
                     and not has_table_privilege('anon', 'controlai.limite', 'select')
                     and (select relrowsecurity from pg_class where oid = 'controlai.limite'::regclass),
                     'limites: RPCs liberadas, internas e tabela fechadas, RLS ligada');
  raise notice '10. limites, vigência e recusas: ok';
end $$;

-- 11. Números do orçamento, num mês fixo -------------------------------------
-- Junho/2025 (30 dias) com p_hoje fixo. Série de R$ 1.500 em Moradia (a pagar:
-- conta igual), R$ 40 direto em Alimentação e R$ 30 na subcategoria dela.
-- Limites: total R$ 1.700 desde janeiro; Moradia R$ 1.500, Alimentação R$ 50
-- e Lazer R$ 200 (sem gasto) desde junho.
do $$
declare
  v_l   uuid := pg_temp.carteira();
  v_mor uuid := pg_temp.cat(v_l, 'Moradia');
  v_ali uuid := pg_temp.cat(v_l, 'Alimentação');
  v_laz uuid := pg_temp.cat(v_l, 'Lazer');
  v_m   text := '2025-06';
  v_sub uuid; v_f uuid; t record;
begin
  v_sub := public.controlai_add_categoria(v_l, 'Restaurante', v_ali);
  insert into controlai.recurring (ledger_id, description, amount_cents, category_id, dia, mes_inicio, total_meses)
  values (v_l, 'Aluguel', 150000, v_mor, 5, v_m, 1) returning id into v_f;
  perform controlai._gerar_fixas(v_l, v_m);
  update controlai.expense set a_pagar = true where recurring_id = v_f;
  insert into controlai.expense (ledger_id, spent_on, amount_cents, category_id)
  values (v_l, '2025-06-03', 4000, v_ali), (v_l, '2025-06-06', 3000, v_sub);
  insert into controlai.limite (ledger_id, category_id, mes_inicio, limite_cents) values (v_l, null, '2025-01', 170000), (v_l, v_mor, v_m, 150000),
                                      (v_l, v_ali, v_m, 5000), (v_l, v_laz, v_m, 20000);

  -- mês corrente, dia 7
  select * into t from controlai._orcamento(v_l, v_m, '2025-06-07') where category_id is null;
  perform pg_temp.ok(t.gasto_cents = controlai._total_mes(v_l, '2025-06-01') and t.gasto_cents = 157000
                     and t.serie_cents = 150000 and t.limite_cents = 170000,
                     'o gasto do total é o _total_mes, com a série a pagar');
  perform pg_temp.ok(t.previsto_cents = 0 and exists (select 1 from controlai._ocorrencias(v_l, v_m, v_m)),
                     'mês corrente com série ativa: previsto 0');
  perform pg_temp.ok(t.projecao_cents = 180000,
                     format('projeção no dia 7 = 150000 + 7000 × 30 / 7 (veio %s)', t.projecao_cents));
  perform pg_temp.ok(t.livre_cents = 13000 and t.livre_dia_cents = 541,
                     format('livre por dia com floor: 13000 / 24 = 541 (veio %s/%s)', t.livre_cents, t.livre_dia_cents));
  perform pg_temp.ok(t.media_dia_cents = 6000, format('média no dia 7 (veio %s)', t.media_dia_cents));
  perform pg_temp.ok((select count(*) from controlai._orcamento(v_l, v_m, '2025-06-07')) = 4
                     and not exists (select 1 from controlai._orcamento(v_l, v_m, '2025-06-07')
                                      where category_id = v_sub),
                     'uma linha de total e uma por categoria limitada, nenhuma de subcategoria');
  select * into t from controlai._orcamento(v_l, v_m, '2025-06-07') where category_id = v_ali;
  perform pg_temp.ok(t.gasto_cents = (select sum(amount_cents) from controlai.expense
                                       where ledger_id = v_l and category_id in (v_ali, v_sub))
                     and t.gasto_cents = 7000 and t.serie_cents = 0,
                     'o rollup do pai é as filhas mais o lançamento direto no pai');
  perform pg_temp.ok(t.livre_cents = -2000 and t.livre_dia_cents = 0
                     and t.projecao_cents is null and t.media_dia_cents is null,
                     'categoria que passou: livre negativo, 0 por dia, sem projeção nem média');
  select * into t from controlai._orcamento(v_l, v_m, '2025-06-07') where category_id = v_laz;
  perform pg_temp.ok(t.gasto_cents = 0 and t.serie_cents = 0 and t.previsto_cents = 0
                     and t.livre_cents = 20000 and t.livre_dia_cents = 833,
                     'categoria limitada sem gasto aparece com 0');
  perform pg_temp.ok((select livre_cents from controlai._orcamento(v_l, v_m, '2025-06-07')
                       where category_id = v_mor) = 0,
                     'chegar exatamente no limite deixa livre 0, não negativo');

  -- dia 6: ainda sem projeção; a média é arredondada (6166,67)
  select * into t from controlai._orcamento(v_l, v_m, '2025-06-06') where category_id is null;
  perform pg_temp.ok(t.projecao_cents is null and t.media_dia_cents = 6167 and t.livre_dia_cents = 520,
                     format('dia 6: sem projeção (veio %s/%s/%s)', t.projecao_cents, t.media_dia_cents, t.livre_dia_cents));

  -- mês passado
  select * into t from controlai._orcamento(v_l, v_m, '2025-07-15') where category_id is null;
  perform pg_temp.ok(t.projecao_cents is null and t.media_dia_cents = 5233 and t.livre_dia_cents is null
                     and t.previsto_cents = 0 and t.livre_cents = 13000,
                     'mês passado: sem projeção nem livre por dia, média = gasto / dias, previsto 0');

  -- mês futuro: as linhas reais mais as ocorrências
  select * into t from controlai._orcamento(v_l, v_m, '2025-05-20') where category_id is null;
  perform pg_temp.ok(t.previsto_cents = (select sum(amount_cents) from controlai._ocorrencias(v_l, v_m, v_m))
                     and t.previsto_cents = 150000 and t.livre_cents = 170000 - 157000 - 150000
                     and t.projecao_cents is null and t.media_dia_cents is null and t.livre_dia_cents is null,
                     'mês futuro: previsto = _ocorrencias, sem projeção, média nem livre por dia');
  perform pg_temp.ok((select previsto_cents from controlai._orcamento(v_l, v_m, '2025-05-20')
                       where category_id = v_mor) = 150000
                     and (select previsto_cents from controlai._orcamento(v_l, v_m, '2025-05-20')
                           where category_id = v_ali) = 0,
                     'mês futuro: o previsto cai na categoria da série');

  -- antes do primeiro limite: só a linha de total, sem limite
  select * into t from controlai._orcamento(v_l, '2024-12', '2024-12-10');
  perform pg_temp.ok((select count(*) from controlai._orcamento(v_l, '2024-12', '2024-12-10')) = 1
                     and t.category_id is null and t.limite_cents is null and t.livre_cents is null
                     and t.livre_dia_cents is null and t.gasto_cents = 0,
                     'sem limite: só o total, com limite, livre e livre por dia nulos');
  raise notice '11. números do orçamento: ok';
end $$;

-- 12. Paridade app × IA, lancar com limites e busca por nome -------------------
-- api_resumo.orcamento (reais) × 100 = controlai_mes.orcamento (centavos), alvo a alvo
create function pg_temp.paridade(p_ledger uuid, p_token text, p_mes text) returns boolean language sql as $$
  with app as (select x from json_array_elements(public.controlai_mes(p_ledger, p_mes)->'orcamento') x),
       ia  as (select public.controlai_api_resumo(p_token, p_mes)->'orcamento' as o),
       par as (select i.o as y, a.x from ia i join app a on a.x->>'category_id' is null
               union all
               select k, a.x from ia i
                cross join lateral json_array_elements(i.o->'categorias') k
                join controlai.category c on c.ledger_id = p_ledger and c.name = k->>'categoria'
                join app a on a.x->>'category_id' = c.id::text)
  select (select count(*) from par) = (select count(*) from app)
     and (select json_array_length(o->'categorias') from ia) = (select count(*) from app) - 1
     and bool_and((y->>'limite')::numeric * 100 is not distinct from (x->>'limite_cents')::numeric
              and (y->>'gasto')::numeric * 100 = (x->>'gasto_cents')::numeric
              and (y->>'fixas_e_parcelas')::numeric * 100 = (x->>'serie_cents')::numeric
              and (y->>'comprometido')::numeric * 100 = (x->>'previsto_cents')::numeric
              and (y->>'livre')::numeric * 100 is not distinct from (x->>'livre_cents')::numeric
              and (y->>'livre_por_dia')::numeric * 100 is not distinct from (x->>'livre_dia_cents')::numeric
              and (y->>'projecao')::numeric * 100 is not distinct from (x->>'projecao_cents')::numeric
              and (y->>'media_por_dia')::numeric * 100 is not distinct from (x->>'media_dia_cents')::numeric)
    from par;
$$;

do $$
declare
  v_l     uuid := pg_temp.carteira();
  v_l2    uuid := pg_temp.carteira();
  v_t     text := public.controlai_get_api_token(v_l);
  v_t2    text := public.controlai_get_api_token(v_l2);
  v_mor   uuid := pg_temp.cat(v_l, 'Moradia');
  v_ali   uuid := pg_temp.cat(v_l, 'Alimentação');
  v_laz   uuid := pg_temp.cat(v_l, 'Lazer');
  v_atual text := controlai._mes_atual();
  v_f uuid; v_top uuid; j json; x json;
begin
  v_f := public.controlai_add_fixa(v_l, 'Aluguel', 150000, v_mor, 1);
  perform public.controlai_add_fixa(v_l, 'Feira', 10000, v_ali, 1);
  perform public.controlai_set_limite(v_l, null, 300000);
  perform public.controlai_set_limite(v_l, v_ali, 50000);
  perform public.controlai_set_limite(v_l, v_laz, 10000);
  perform public.controlai_add_despesa(v_l, controlai._hoje(), 2500, v_ali);

  j := public.controlai_mes(v_l, v_atual);
  x := j->'orcamento'->0;
  perform pg_temp.ok(json_array_length(j->'orcamento') = 3 and x->>'category_id' is null
                     and (x->>'gasto_cents')::bigint = (j->>'total_cents')::bigint
                     and (x->>'limite_cents')::integer = 300000
                     and (select count(*) from json_object_keys(x)) = 9,
                     'controlai_mes.orcamento: o total primeiro, gasto = total_cents, as 9 chaves');
  perform pg_temp.ok(pg_temp.paridade(v_l, v_t, v_atual), 'paridade app × IA no mês corrente');
  perform pg_temp.ok(pg_temp.paridade(v_l, v_t, controlai._mes_add(v_atual, 1)), 'paridade app × IA no mês futuro');
  perform pg_temp.ok(pg_temp.paridade(v_l, v_t, controlai._mes_add(v_atual, -1)),
                     'paridade app × IA no mês passado, sem limite');

  x := public.controlai_api_resumo(v_t)->'orcamento';
  perform pg_temp.ok((select count(*) from json_object_keys(x)) = 11
                     and (select count(*) from json_object_keys(x->'categorias'->0)) = 8
                     and (x->>'fixas_e_parcelas')::numeric = 1600 and not (x->>'passou')::boolean
                     and x->'categorias'->0->>'categoria' = 'Alimentação',
                     'api_resumo.orcamento: as chaves do contrato e a ordem por consumo');
  x := public.controlai_api_resumo(v_t2)->'orcamento';
  perform pg_temp.ok(x->>'limite' is null and x->>'livre' is null and x->>'livre_por_dia' is null
                     and x->>'passou' is null and x->>'vai_passar' is null
                     and json_array_length(x->'categorias') = 0 and x->>'gasto' is not null,
                     'api_resumo sem limite: limite, livre e passou nulos');

  -- virada do mês sem abrir o app: a fixa do mês ainda não está gravada, e o
  -- lancar põe em dia antes de calcular o livre
  delete from controlai.expense where recurring_id = v_f;
  update controlai.ledger set fixas_ate = controlai._mes_add(v_atual, -1) where id = v_l;
  j := public.controlai_api_lancar(v_t, 150, 'Lazer');
  perform pg_temp.ok(json_array_length(j->'limites') = 2
                     and j->'limites'->0->>'alvo' = 'total' and j->'limites'->1->>'alvo' = 'Lazer'
                     and (j->'limites'->1->>'limite')::numeric = 100 and (j->'limites'->1->>'livre')::numeric = -50
                     and (j->'limites'->1->>'passou')::boolean
                     and (j->'limites'->0->>'livre')::numeric = 3000 - 1500 - 100 - 25 - 150,
                     'lancar devolve limites: o total (com a fixa do mês) e a categoria lançada, com passou');
  perform public.controlai_add_categoria(v_l, 'Padaria', v_ali);
  j := public.controlai_api_lancar(v_t, 5, 'Padaria');
  perform pg_temp.ok(json_array_length(j->'limites') = 2 and j->'limites'->1->>'alvo' = 'Alimentação'
                     and (j->'limites'->1->>'livre')::numeric = 500 - 100 - 25 - 5,
                     'lancar em subcategoria devolve o limite do pai');
  j := public.controlai_api_lancar(v_t, 1, 'Moradia');
  perform pg_temp.ok(json_array_length(j->'limites') = 1 and j->'limites'->0->>'alvo' = 'total',
                     'lancar em categoria sem limite: só o total');
  perform pg_temp.ok(json_array_length(public.controlai_api_lancar(v_t2, 1, 'Moradia')->'limites') = 0,
                     'lancar em carteira sem limite: limites vazio');
  x := public.controlai_api_resumo(v_t)->'orcamento';
  perform pg_temp.ok(x->'categorias'->0->>'categoria' = 'Lazer' and (x->'categorias'->0->>'passou')::boolean,
                     'api_resumo: quem passou vem primeiro');

  -- o mesmo nome em subcategoria e em categoria: a busca exata prefere o 1º
  -- nível, mesmo com a subcategoria criada antes
  perform public.controlai_add_categoria(v_l, 'Viagem', v_laz);
  v_top := public.controlai_add_categoria(v_l, 'Viagem');
  perform pg_temp.ok(controlai._categoria_por_nome(v_l, 'viagem') = v_top, 'a busca exata prefere o 1º nível');
  raise notice '12. paridade, lancar e busca por nome: ok';
end $$;

select 'checks ok: ' || current_setting('checks.n') as resultado;
rollback;
