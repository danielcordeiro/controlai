-- ============================================================================
-- Controlaí — API para IA (conector MCP no claude.ai, ChatGPT, Claude Code)
--
-- Rode DEPOIS do schema.sql. Idempotente.
--
-- Modelo igual ao do Rachaí: cada carteira tem um api_token próprio (ctl_...),
-- separado do UUID do link. Rotacionar um NÃO derruba o outro. As funções api_*
-- recebem o token e trabalham com NOMES e REAIS (não uuid nem centavos), porque
-- é assim que a instrução chega de um humano falando com uma IA.
--
-- O servidor MCP que expõe isso como conector está em
-- supabase/functions/controlai-mcp/ (Edge Function, verify_jwt desligado porque
-- a autenticação é o token na URL).
-- ============================================================================

alter table controlai.ledger add column if not exists api_token text;
create unique index if not exists ledger_api_token_idx
  on controlai.ledger (api_token) where api_token is not null;

-- ---------------------------------------------------------------- token

create or replace function public.controlai_get_api_token(p_ledger uuid)
returns text language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_token text;
begin
  perform controlai._ledger_ok(p_ledger);
  -- gera na primeira leitura; o coalesce evita que duas chamadas simultâneas
  -- gerem tokens divergentes (a segunda relê o que já foi gravado)
  update controlai.ledger
     set api_token = coalesce(api_token, 'ctl_' || replace(gen_random_uuid()::text, '-', ''))
   where id = p_ledger
  returning api_token into v_token;
  return v_token;
end;
$$;

create or replace function public.controlai_rotate_api_token(p_ledger uuid)
returns text language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_token text;
begin
  perform controlai._ledger_ok(p_ledger);
  v_token := 'ctl_' || replace(gen_random_uuid()::text, '-', '');
  update controlai.ledger set api_token = v_token where id = p_ledger;
  return v_token;
end;
$$;

-- ---------------------------------------------------------------- helpers

-- Normalização de acento sem depender da extensão unaccent.
create or replace function controlai.unaccent_simples(p text)
returns text language sql immutable set search_path = pg_temp as $$
  select lower(translate(coalesce(p, ''),
    'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'));
$$;

create or replace function controlai._por_token(p_token text)
returns uuid language plpgsql stable set search_path = controlai, public, pg_temp as $$
declare v_id uuid;
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'Token não informado. Peça o token na aba IA do Controlaí.';
  end if;
  select id into v_id from controlai.ledger where api_token = btrim(p_token);
  if v_id is null then
    raise exception 'Token inválido ou revogado.';
  end if;
  return v_id;
end;
$$;

-- Acha a categoria pelo NOME: exato (sem acento/caixa), depois prefixo.
-- Não cria sozinha — categoria nascida de erro de digitação polui o plano de
-- contas. Em vez disso, erra listando as opções.
create or replace function controlai._categoria_por_nome(p_ledger uuid, p_nome text)
returns uuid language plpgsql stable set search_path = controlai, public, pg_temp as $$
declare v_id uuid; v_nome text; v_opcoes text;
begin
  v_nome := lower(btrim(coalesce(p_nome, '')));
  if v_nome = '' then
    raise exception 'Informe a categoria.';
  end if;
  -- o mesmo nome pode existir como categoria e como subcategoria: vale a de 1º nível
  select c.id into v_id from controlai.category c
   where c.ledger_id = p_ledger and not c.archived
     and controlai.unaccent_simples(c.name) = controlai.unaccent_simples(v_nome)
   order by c.parent_id is not null, c.created_at
   limit 1;
  if v_id is null then
    select c.id into v_id from controlai.category c
     where c.ledger_id = p_ledger and not c.archived
       and controlai.unaccent_simples(c.name) like controlai.unaccent_simples(v_nome) || '%'
     order by length(c.name) limit 1;
  end if;
  if v_id is null then
    select c.id into v_id from controlai.category c
     where c.ledger_id = p_ledger and not c.archived
       and controlai.unaccent_simples(c.name) like '%' || controlai.unaccent_simples(v_nome) || '%'
     order by length(c.name) limit 1;
  end if;
  if v_id is null then
    select string_agg(c.name, ', ' order by c.sort_order, c.name) into v_opcoes
      from controlai.category c where c.ledger_id = p_ledger and not c.archived;
    raise exception 'Categoria "%" não existe. Disponíveis: %. Use controlai_api_criar_categoria para criar.', p_nome, v_opcoes;
  end if;
  return v_id;
end;
$$;

create or replace function controlai._forma_por_nome(p_ledger uuid, p_nome text)
returns uuid language plpgsql stable set search_path = controlai, public, pg_temp as $$
declare v_id uuid; v_nome text;
begin
  v_nome := btrim(coalesce(p_nome, ''));
  if v_nome = '' then return null; end if;   -- forma é OPCIONAL
  select m.id into v_id from controlai.payment_method m
   where m.ledger_id = p_ledger and not m.archived
     and controlai.unaccent_simples(m.name) = controlai.unaccent_simples(v_nome)
   limit 1;
  if v_id is null then
    select m.id into v_id from controlai.payment_method m
     where m.ledger_id = p_ledger and not m.archived
       and controlai.unaccent_simples(m.name) like controlai.unaccent_simples(v_nome) || '%'
     order by length(m.name) limit 1;
  end if;
  if v_id is null then
    select m.id into v_id from controlai.payment_method m
     where m.ledger_id = p_ledger and not m.archived
       and controlai.unaccent_simples(m.name) like '%' || controlai.unaccent_simples(v_nome) || '%'
     order by length(m.name) limit 1;
  end if;
  return v_id;   -- não achou: grava sem forma, em vez de recusar o lançamento
end;
$$;

-- ---------------------------------------------------------------- API
-- (corpo completo aplicado no banco; ver migrações controlai_api_para_ia e
--  controlai_corrige_mensagem_data_futura)

create or replace function public.controlai_api_contexto(p_token text)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  return json_build_object(
    'carteira', (select l.name from controlai.ledger l where l.id = v_ledger),
    'hoje', to_char(controlai._hoje(), 'YYYY-MM-DD'),
    'mes_atual', controlai._mes_atual(),
    'moeda', 'BRL',
    'categorias', coalesce((
      select json_agg(json_build_object(
               'nome', c.name,
               'subcategorias', coalesce((select json_agg(f.name order by f.name)
                                            from controlai.category f
                                           where f.parent_id = c.id and not f.archived), '[]'::json))
             order by c.sort_order, c.name)
        from controlai.category c
       where c.ledger_id = v_ledger and c.parent_id is null and not c.archived), '[]'::json),
    'formas_pagamento', coalesce((
      select json_agg(m.name order by m.sort_order, m.name)
        from controlai.payment_method m where m.ledger_id = v_ledger and not m.archived), '[]'::json)
  );
end;
$$;

-- 'limites': como ficaram o total e a categoria-topo lançada no mês da data,
-- só os que têm limite vigente. O catch-up vem antes: sem as fixas do mês já
-- gravadas, o livre sairia maior do que é.
create or replace function public.controlai_api_lancar(
  p_token text, p_valor numeric, p_categoria text,
  p_data text default null, p_forma text default null, p_descricao text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_cat uuid; v_forma uuid; v_data date; v_cents integer; v_id uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  -- as faixas antes do ::integer: depois dele, o que passa do teto já virou
  -- erro cru do Postgres
  if p_valor is null or round(p_valor * 100) <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if round(p_valor * 100) > 2147483647 then
    raise exception 'Valor grande demais.';
  end if;
  v_cents := round(p_valor * 100)::integer;
  v_cat   := controlai._categoria_por_nome(v_ledger, p_categoria);
  v_forma := controlai._forma_por_nome(v_ledger, p_forma);
  v_data  := coalesce(nullif(btrim(coalesce(p_data, '')), '')::date,
                      controlai._hoje());
  perform controlai._data_ok(v_data);
  insert into controlai.expense (ledger_id, spent_on, amount_cents, category_id, payment_method_id, description)
  values (v_ledger, v_data, v_cents, v_cat, v_forma, left(coalesce(btrim(p_descricao), ''), 140))
  returning id into v_id;
  return json_build_object(
    'ok', true, 'id', v_id,
    'data', to_char(v_data, 'YYYY-MM-DD'),
    'valor', round(v_cents / 100.0, 2),
    'categoria', (select name from controlai.category where id = v_cat),
    'forma_pagamento', (select name from controlai.payment_method where id = v_forma),
    'descricao', left(coalesce(btrim(p_descricao), ''), 140),
    'limites', coalesce((
      select json_agg(json_build_object('alvo', case when o.category_id is null then 'total' else c.name end,
                                        'limite', round(o.limite_cents / 100.0, 2),
                                        'livre', round(o.livre_cents / 100.0, 2),
                                        'passou', o.livre_cents < 0)
                      order by o.category_id nulls first)
        from controlai._orcamento(v_ledger, to_char(v_data, 'YYYY-MM')) o
        left join controlai.category c on c.id = o.category_id
       where o.limite_cents is not null
         and (o.category_id is null
              or o.category_id = (select coalesce(x.parent_id, x.id) from controlai.category x
                                   where x.id = v_cat))), '[]'::json));
end;
$$;

-- 'total' é o que já aconteceu (pago + a pagar). Em mês futuro, o que as séries
-- vão lançar vem à parte, em 'comprometido', e não há comparação com o anterior.
-- 'orcamento' é controlai._orcamento em reais, o mesmo número do app: limite,
-- livre, projeção (fixas e parcelas já estão lançadas desde o dia 1, então
-- extrapolar o total inflaria a conta) e as categorias com limite. Sem limite,
-- limite, livre, livre_por_dia e passou/vai_passar vêm nulos.
create or replace function public.controlai_api_resumo(p_token text, p_mes text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_ini date; v_fim date; v_mes text; v_total bigint; v_ant bigint;
        v_a_pagar bigint; v_comp bigint; v_comp_conf bigint;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  v_ini := controlai._mes_inicio(p_mes);
  v_fim := (v_ini + interval '1 month')::date;
  v_mes := to_char(v_ini, 'YYYY-MM');
  v_total := controlai._total_mes(v_ledger, v_ini);
  if v_mes <= controlai._mes_atual() then
    v_ant := controlai._total_mes(v_ledger, (v_ini - interval '1 month')::date);
  end if;
  select coalesce(sum(e.amount_cents), 0) into v_a_pagar from controlai.expense e
   where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim and e.a_pagar;
  select coalesce(sum(o.amount_cents), 0), coalesce(sum(o.amount_cents) filter (where o.a_pagar), 0)
    into v_comp, v_comp_conf
    from controlai._ocorrencias(v_ledger, v_mes, v_mes) o
   where v_mes > controlai._mes_atual();
  return json_build_object(
    'mes', v_mes,
    'total', round(v_total / 100.0, 2),
    'pago', round((v_total - v_a_pagar) / 100.0, 2),
    'a_pagar', round(v_a_pagar / 100.0, 2),
    'comprometido', round(v_comp / 100.0, 2),
    'comprometido_a_confirmar', round(v_comp_conf / 100.0, 2),
    'total_mes_anterior', round(v_ant / 100.0, 2),
    'variacao_pct', case when v_ant > 0 then round(((v_total - v_ant) * 100.0) / v_ant, 1) else null end,
    'lancamentos', (select count(*) from controlai.expense e
                     where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim),
    'por_categoria', coalesce((
      select json_agg(json_build_object('categoria', nome, 'valor', round(cents / 100.0, 2),
                                        'pct', case when v_total > 0 then round((cents * 100.0) / v_total, 1) else 0 end)
                      order by cents desc)
        from (select coalesce(p.name, c.name, 'Sem categoria') as nome, sum(e.amount_cents) as cents
                from controlai.expense e
                left join controlai.category c on c.id = e.category_id
                left join controlai.category p on p.id = c.parent_id
               where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim
               group by 1) t), '[]'::json),
    'por_forma_pagamento', coalesce((
      select json_agg(json_build_object('forma', nome, 'valor', round(cents / 100.0, 2)) order by cents desc)
        from (select coalesce(m.name, 'Não informada') as nome, sum(e.amount_cents) as cents
                from controlai.expense e
                left join controlai.payment_method m on m.id = e.payment_method_id
               where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim
               group by 1) t), '[]'::json),
    'orcamento', (
      with o as (select * from controlai._orcamento(v_ledger, v_mes))
      select json_build_object(
               'limite', round(t.limite_cents / 100.0, 2),
               'gasto', round(t.gasto_cents / 100.0, 2),
               'fixas_e_parcelas', round(t.serie_cents / 100.0, 2),
               'comprometido', round(t.previsto_cents / 100.0, 2),
               'livre', round(t.livre_cents / 100.0, 2),
               'livre_por_dia', round(t.livre_dia_cents / 100.0, 2),
               'projecao', round(t.projecao_cents / 100.0, 2),
               'media_por_dia', round(t.media_dia_cents / 100.0, 2),
               'passou', t.livre_cents < 0,
               'vai_passar', t.projecao_cents > t.limite_cents,
               -- quem passou primeiro, depois o maior consumo sobre o limite
               'categorias', coalesce((
                 select json_agg(json_build_object(
                          'categoria', c.name,
                          'limite', round(k.limite_cents / 100.0, 2),
                          'gasto', round(k.gasto_cents / 100.0, 2),
                          'fixas_e_parcelas', round(k.serie_cents / 100.0, 2),
                          'comprometido', round(k.previsto_cents / 100.0, 2),
                          'livre', round(k.livre_cents / 100.0, 2),
                          'livre_por_dia', round(k.livre_dia_cents / 100.0, 2),
                          'passou', k.livre_cents < 0)
                        order by (k.gasto_cents + k.previsto_cents)::numeric / k.limite_cents desc, c.name)
                   from o k join controlai.category c on c.id = k.category_id), '[]'::json))
        from o t where t.category_id is null));
end;
$$;

-- "Limite de R$ 3.000 no mês", "de 800 em Mercado": vale do mês atual em
-- diante. 0 remove. A regra (1º nível, vigência) mora em controlai_set_limite;
-- 'situacao' é o alvo no formato do orcamento de api_resumo (nula ao remover).
create or replace function public.controlai_api_definir_limite(
  p_token text, p_valor numeric, p_categoria text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_cat uuid; v_nome text; v_cents integer; v_orc json;
begin
  v_ledger := controlai._por_token(p_token);
  -- as faixas antes do ::integer (ver api_lancar)
  if p_valor is null or round(p_valor * 100) < 0 then
    raise exception 'Informe o limite em reais (0 remove).';
  end if;
  if round(p_valor * 100) > 2147483647 then
    raise exception 'Valor grande demais.';
  end if;
  v_cents := nullif(round(p_valor * 100)::integer, 0);
  if coalesce(btrim(p_categoria), '') <> '' then
    -- a arquivada com limite continua no resumo; sem isto a IA a veria e não
    -- conseguiria tirar o limite (_categoria_por_nome só olha as ativas)
    select c.id into v_cat from controlai.category c
      join controlai._limites(v_ledger, controlai._mes_atual()) l on l.category_id = c.id
     where c.ledger_id = v_ledger and c.archived
       and controlai.unaccent_simples(c.name) = controlai.unaccent_simples(btrim(p_categoria))
     limit 1;
    if v_cat is null then
      v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
    end if;
    select name into v_nome from controlai.category where id = v_cat;
  end if;
  perform public.controlai_set_limite(v_ledger, v_cat, v_cents);
  v_orc := public.controlai_api_resumo(p_token)->'orcamento';
  return json_build_object(
    'ok', true,
    'categoria', v_nome,
    'limite', round(v_cents / 100.0, 2),
    'a_partir_de', controlai._mes_atual(),
    'situacao', case when v_cents is null then null
                     when v_cat is null then v_orc
                     else (select k from json_array_elements(v_orc->'categorias') k
                            where k->>'categoria' = v_nome) end);
end;
$$;

-- Em mês futuro entram também as previstas das séries (prevista: true, sem id:
-- não há o que editar). O limite vale antes de agregar; depois do json_agg ele
-- não cortava nada.
create or replace function public.controlai_api_listar(
  p_token text, p_mes text default null, p_categoria text default null, p_limite integer default 50)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_ini date; v_fim date; v_mes text; v_cat uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  v_ini := controlai._mes_inicio(p_mes);
  v_fim := (v_ini + interval '1 month')::date;
  v_mes := to_char(v_ini, 'YYYY-MM');
  if coalesce(btrim(p_categoria), '') <> '' then
    v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
  end if;
  return coalesce((
    select json_agg(json_build_object(
             'id', i.id, 'data', to_char(i.dia, 'YYYY-MM-DD'),
             'valor', round(i.cents / 100.0, 2),
             'categoria', i.categoria, 'forma_pagamento', i.forma,
             'descricao', nullif(i.descricao, ''),
             'de_fixa', i.rec is not null, 'a_pagar', i.a_pagar,
             'parcela', i.parcela || '/' || i.parcelas, 'prevista', i.id is null)
           order by i.dia desc, i.criado desc)
      from (select u.*, c.name as categoria, m.name as forma
              from (select e.id, e.spent_on as dia, e.amount_cents as cents, e.category_id as cat,
                           e.payment_method_id as forma_id, e.description as descricao,
                           e.recurring_id as rec, e.a_pagar,
                           controlai._parcela(r, e.recurring_month) as parcela,
                           r.total_meses as parcelas, e.created_at as criado
                      from controlai.expense e
                      left join controlai.recurring r on r.id = e.recurring_id
                     where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim
                    union all
                    select null, o.vence, o.amount_cents, o.category_id, o.payment_method_id,
                           o.description, o.recurring_id, o.a_pagar, o.parcela, o.parcelas, null
                      from controlai._ocorrencias(v_ledger, v_mes, v_mes) o
                     where v_mes > controlai._mes_atual()) u
              left join controlai.category c on c.id = u.cat
              left join controlai.payment_method m on m.id = u.forma_id
             where v_cat is null or u.cat = v_cat or c.parent_id = v_cat
             order by u.dia desc, u.criado desc
             limit greatest(1, least(coalesce(p_limite, 50), 200))) i), '[]'::json);
end;
$$;

create or replace function public.controlai_api_editar(
  p_token text, p_id uuid, p_valor numeric default null, p_categoria text default null,
  p_data text default null, p_forma text default null, p_descricao text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_cents integer; v_cat uuid; v_data date;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._pertence(v_ledger, 'expense', p_id);
  if p_valor is not null then
    if round(p_valor * 100) <= 0 then raise exception 'O valor precisa ser maior que zero.'; end if;
    if round(p_valor * 100) > 2147483647 then raise exception 'Valor grande demais.'; end if;
    v_cents := round(p_valor * 100)::integer;
  end if;
  if coalesce(btrim(p_categoria), '') <> '' then
    v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
  end if;
  if coalesce(btrim(p_data), '') <> '' then
    v_data := p_data::date;
    perform controlai._data_ok(v_data, e.spent_on, e.a_pagar)
       from controlai.expense e where e.id = p_id and e.ledger_id = v_ledger;
  end if;
  update controlai.expense
     set amount_cents      = coalesce(v_cents, amount_cents),
         category_id       = coalesce(v_cat, category_id),
         spent_on          = coalesce(v_data, spent_on),
         payment_method_id = case when coalesce(btrim(p_forma), '') <> ''
                                  then controlai._forma_por_nome(v_ledger, p_forma)
                                  else payment_method_id end,
         description       = case when p_descricao is not null
                                  then left(btrim(p_descricao), 140) else description end,
         updated_at        = now()
   where id = p_id and ledger_id = v_ledger;
  perform controlai._solta_da_fixa(p_id);
  return json_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.controlai_api_apagar(p_token text, p_id uuid)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_rec uuid; v_a_pagar boolean;
begin
  v_ledger := controlai._por_token(p_token);
  select recurring_id, a_pagar into v_rec, v_a_pagar
    from controlai.expense where id = p_id and ledger_id = v_ledger;
  -- a semântica "apagar ocorrência = pular o mês" mora em controlai_del_despesa
  perform public.controlai_del_despesa(v_ledger, p_id);
  return json_build_object('ok', true,
    'observacao', case when v_a_pagar
                       then 'Era uma parcela a pagar: fica registrado que esta não será paga. Se foi paga, o certo era marcar_pago.'
                       when v_rec is not null
                       then 'Era a ocorrência de uma despesa fixa: só este mês saiu, a fixa continua.' end);
end;
$$;

create or replace function public.controlai_api_criar_categoria(
  p_token text, p_nome text, p_pai text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_pai uuid; v_id uuid; v_nome text; v_qtd integer;
begin
  v_ledger := controlai._por_token(p_token);
  v_nome := btrim(coalesce(p_nome, ''));
  if v_nome = '' then raise exception 'Informe o nome da categoria.'; end if;
  if coalesce(btrim(p_pai), '') <> '' then
    v_pai := controlai._categoria_por_nome(v_ledger, p_pai);
    if exists (select 1 from controlai.category where id = v_pai and parent_id is not null) then
      raise exception 'Subcategoria não pode ter subcategoria.';
    end if;
  end if;
  select count(*) into v_qtd from controlai.category where ledger_id = v_ledger;
  if v_qtd >= 100 then raise exception 'Limite de categorias atingido.'; end if;
  insert into controlai.category (ledger_id, parent_id, name, color)
  values (v_ledger, v_pai, left(v_nome, 40), '#6366f1')
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'nome', left(v_nome, 40));
exception when unique_violation then
  raise exception 'Já existe uma categoria com esse nome aqui.';
end;
$$;

-- ------------------------------------------------------------ despesas fixas
-- A IA cria a REGRA, não doze lançamentos: as ocorrências são gravadas mês a
-- mês e o futuro é calculado (ver supabase/fixas.sql). Por isso 'criar_fixa' e
-- não um laço de 'lancar' — parcelado inclusive.
-- A parte própria desta camada é só traduzir nome -> uuid e reais -> centavos;
-- validação, insert e catch-up ficam em controlai_add_fixa, um lugar só.

-- As assinaturas ganharam parâmetros (p_mes_inicio; depois p_confirmar e
-- p_valor_total): sem o drop, o create abaixo viraria uma sobrecarga e a
-- chamada por nome ficaria ambígua no PostgREST.
drop function if exists public.controlai_api_criar_fixa(text, numeric, text, integer, integer, text, text);
drop function if exists public.controlai_api_criar_fixa(text, numeric, text, integer, integer, text, text, text);
drop function if exists public.controlai_api_editar_fixa(text, uuid, numeric, text, integer, integer, text, text, boolean);

-- Parcelado é esta mesma função com 'meses'. Valor da parcela OU valor_total,
-- exatamente um: por isso os dois têm default e quem confere é controlai_add_fixa.
create or replace function public.controlai_api_criar_fixa(
  p_token text, p_valor numeric default null, p_categoria text default null,
  p_dia integer default null, p_meses integer default null, p_forma text default null,
  p_descricao text default null, p_mes_inicio text default null,
  p_confirmar boolean default false, p_valor_total numeric default null)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_cat uuid; v_forma uuid; v_id uuid;
        v_dia integer; v_inicio text; v_atual text; r controlai.recurring;
begin
  v_ledger := controlai._por_token(p_token);
  -- só a faixa, antes do ::integer (ver api_lancar); valor ausente fica para
  -- controlai_add_fixa
  if round(p_valor * 100) <= 0 or round(p_valor_total * 100) <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if greatest(round(p_valor * 100), round(p_valor_total * 100)) > 2147483647 then
    raise exception 'Valor grande demais.';
  end if;
  v_cat   := controlai._categoria_por_nome(v_ledger, p_categoria);
  v_forma := controlai._forma_por_nome(v_ledger, p_forma);
  v_atual := controlai._mes_atual();
  v_dia   := coalesce(p_dia, extract(day from controlai._hoje())::integer);
  v_inicio := coalesce(nullif(btrim(coalesce(p_mes_inicio, '')), ''), v_atual);

  v_id := public.controlai_add_fixa(v_ledger, p_descricao, round(p_valor * 100)::integer, v_cat,
                                    v_dia, v_inicio, p_meses, v_forma, coalesce(p_confirmar, false),
                                    round(p_valor_total * 100)::integer);

  select * into r from controlai.recurring where id = v_id;
  return json_build_object(
    'ok', true, 'id', v_id,
    'descricao', r.description,
    'valor', round(r.amount_cents / 100.0, 2),
    'valor_total', round(coalesce(r.total_cents, r.amount_cents::bigint * r.total_meses) / 100.0, 2),
    'categoria', (select name from controlai.category where id = v_cat),
    'forma_pagamento', (select name from controlai.payment_method where id = v_forma),
    'dia', v_dia,
    'mes_inicio', v_inicio,
    'repeticoes', case when p_meses is null then 'até cancelar' else p_meses::text end,
    'confirmar', r.confirmar,
    'observacao', case when v_inicio > v_atual
                       then 'Começa no futuro: nada foi lançado ainda.'
                       when r.confirmar
                       then 'O que venceu antes de hoje entrou como pago; o resto fica a pagar até marcar_pago.' end);
end;
$$;

create or replace function public.controlai_api_listar_fixas(p_token text)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  return coalesce((
    select json_agg(json_build_object(
             'id', r.id,
             'descricao', nullif(r.description, ''),
             'valor', round(r.amount_cents / 100.0, 2),
             'categoria', c.name,
             'forma_pagamento', m.name,
             'dia', r.dia,
             'mes_inicio', r.mes_inicio,
             'repeticoes', case when r.total_meses is null then 'até cancelar' else r.total_meses::text end,
             'lancadas', (select count(*) from controlai.expense e where e.recurring_id = r.id),
             'ativa', controlai._fixa_ativa(r),
             'confirmar', r.confirmar,
             'valor_total', round(coalesce(r.total_cents, r.amount_cents::bigint * r.total_meses) / 100.0, 2),
             'pagas', a.pagas,
             'pendentes', a.pendentes,
             -- restantes e falta ficam nulos em série sem fim
             'restantes', a.pendentes + a.futuras,
             'falta', round((a.pendentes_cents + a.futuras_cents) / 100.0, 2))
           order by r.created_at)
      from controlai.recurring r
      cross join lateral controlai._andamento(r) a
      left join controlai.category c on c.id = r.category_id
      left join controlai.payment_method m on m.id = r.payment_method_id
     where r.ledger_id = v_ledger), '[]'::json);
end;
$$;

-- Cancelar é a mesma regra do app ("para no mês que vem"), então é a mesma
-- função: duas cópias divergiriam no dia em que a regra mudasse.
create or replace function public.controlai_api_cancelar_fixa(p_token text, p_id uuid)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
begin
  perform public.controlai_cancelar_fixa(controlai._por_token(p_token), p_id, null);
  return json_build_object('ok', true,
    'observacao', 'Para de lançar a partir do mês que vem; o histórico continua.');
end;
$$;

-- Editar pelo conector. Sem isto o único caminho seria cancelar e criar outra,
-- que duplicaria a ocorrência do mês corrente. Semântica de patch (só o que
-- veio muda), diferente de controlai_update_fixa, que substitui tudo.
create or replace function public.controlai_api_editar_fixa(
  p_token text, p_id uuid, p_valor numeric default null, p_categoria text default null,
  p_dia integer default null, p_meses integer default null, p_forma text default null,
  p_descricao text default null, p_ate_cancelar boolean default null,
  p_confirmar boolean default null)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; r controlai.recurring; v_cents integer; v_cat uuid; v_meses integer;
begin
  v_ledger := controlai._por_token(p_token);
  select * into r from controlai.recurring where id = p_id and ledger_id = v_ledger;
  if not found then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  if coalesce(p_ate_cancelar, false) and p_meses is not null then
    raise exception 'Escolha uma coisa só: um número de meses OU até cancelar.';
  end if;
  if p_valor is not null then
    if round(p_valor * 100) <= 0 then raise exception 'O valor precisa ser maior que zero.'; end if;
    if round(p_valor * 100) > 2147483647 then raise exception 'Valor grande demais.'; end if;
    v_cents := round(p_valor * 100)::integer;
  end if;
  if coalesce(btrim(p_categoria), '') <> '' then
    v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
  end if;
  -- omitir "meses" mantém o que estava; só 'ate_cancelar' torna indeterminada
  v_meses := case when coalesce(p_ate_cancelar, false) then null
                  when p_meses is not null then p_meses
                  else r.total_meses end;

  perform public.controlai_update_fixa(
    v_ledger, p_id,
    case when p_descricao is not null then btrim(p_descricao) else r.description end,
    coalesce(v_cents, r.amount_cents),
    coalesce(v_cat, r.category_id),
    coalesce(p_dia, r.dia),
    v_meses,
    case when coalesce(btrim(p_forma), '') <> ''
         then controlai._forma_por_nome(v_ledger, p_forma) else r.payment_method_id end,
    p_confirmar);

  select * into r from controlai.recurring where id = p_id;
  return json_build_object(
    'ok', true, 'id', p_id,
    'descricao', nullif(r.description, ''),
    'valor', round(r.amount_cents / 100.0, 2),
    'categoria', (select name from controlai.category where id = r.category_id),
    'forma_pagamento', (select name from controlai.payment_method where id = r.payment_method_id),
    'dia', r.dia,
    'repeticoes', case when r.total_meses is null then 'até cancelar' else r.total_meses::text end,
    'confirmar', r.confirmar,
    'observacao', 'Vale para os próximos lançamentos; o que já foi lançado não muda.');
end;
$$;

-- "Paguei a geladeira": contas_a_pagar dá o id, esta marca. pago=false desfaz.
-- A regra (avulsa não volta para a pagar) mora em controlai_marcar_pago.
create or replace function public.controlai_api_marcar_pago(
  p_token text, p_id uuid, p_pago boolean default true)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform public.controlai_marcar_pago(v_ledger, p_id, p_pago);
  return (select json_build_object('ok', true, 'id', e.id, 'a_pagar', e.a_pagar,
                                   'descricao', nullif(e.description, ''),
                                   'vencimento', to_char(e.spent_on, 'YYYY-MM-DD'),
                                   'valor', round(e.amount_cents / 100.0, 2))
            from controlai.expense e where e.id = p_id and e.ledger_id = v_ledger);
end;
$$;

-- Tudo o que está a pagar na carteira: atrasadas (vencimento antes de hoje),
-- as que ainda vencem este mês, as que vão pedir confirmação no mês que vem e
-- o andamento de cada série a confirmar. Linha a pagar nunca passa do mês
-- corrente (fixas.sql), então "não atrasada" é "vence este mês".
create or replace function public.controlai_api_contas_a_pagar(p_token text)
returns json language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_hoje date := controlai._hoje(); v_prox text;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._catchup_fixas(v_ledger);
  v_prox := controlai._mes_add(controlai._mes_atual(), 1);
  return (
    with p as (
      select e.id, nullif(e.description, '') as descricao, c.name as categoria,
             e.spent_on, e.amount_cents, e.spent_on < v_hoje as atrasada,
             controlai._parcela(r, e.recurring_month) || '/' || r.total_meses as parcela
        from controlai.expense e
        left join controlai.category c on c.id = e.category_id
        left join controlai.recurring r on r.id = e.recurring_id
       where e.ledger_id = v_ledger and e.a_pagar)
    select json_build_object(
      'hoje', to_char(v_hoje, 'YYYY-MM-DD'),
      'total_atrasado', (select round(coalesce(sum(amount_cents), 0) / 100.0, 2) from p where atrasada),
      'total_este_mes', (select round(coalesce(sum(amount_cents), 0) / 100.0, 2) from p where not atrasada),
      'atrasadas', coalesce((
        select json_agg(json_build_object('id', id, 'descricao', descricao, 'categoria', categoria,
                                          'vencimento', to_char(spent_on, 'YYYY-MM-DD'),
                                          'valor', round(amount_cents / 100.0, 2), 'parcela', parcela)
                        order by spent_on)
          from p where atrasada), '[]'::json),
      'vencem_este_mes', coalesce((
        select json_agg(json_build_object('id', id, 'descricao', descricao, 'categoria', categoria,
                                          'vencimento', to_char(spent_on, 'YYYY-MM-DD'),
                                          'valor', round(amount_cents / 100.0, 2), 'parcela', parcela)
                        order by spent_on)
          from p where not atrasada), '[]'::json),
      'proximas', coalesce((
        select json_agg(json_build_object('descricao', nullif(o.description, ''),
                                          'vencimento', to_char(o.vence, 'YYYY-MM-DD'),
                                          'valor', round(o.amount_cents / 100.0, 2),
                                          'parcela', o.parcela || '/' || o.parcelas)
                        order by o.vence)
          from controlai._ocorrencias(v_ledger, v_prox, v_prox) o where o.a_pagar), '[]'::json),
      -- restantes e falta ficam nulos em série sem fim
      'series', coalesce((
        select json_agg(json_build_object('fixa_id', r.id, 'descricao', nullif(r.description, ''),
                                          'pagas', a.pagas, 'pendentes', a.pendentes,
                                          'restantes', a.pendentes + a.futuras,
                                          'falta', round((a.pendentes_cents + a.futuras_cents) / 100.0, 2))
                        order by r.created_at)
          from controlai.recurring r
          cross join lateral controlai._andamento(r) a
         where r.ledger_id = v_ledger and r.confirmar
           and (controlai._fixa_ativa(r) or a.pendentes > 0)), '[]'::json)));
end;
$$;

-- ---------------------------------------------------------------- permissões
revoke all on function controlai._por_token(text)                from anon, authenticated, public;
revoke all on function controlai._categoria_por_nome(uuid, text) from anon, authenticated, public;
revoke all on function controlai._forma_por_nome(uuid, text)     from anon, authenticated, public;
revoke all on function controlai.unaccent_simples(text)          from anon, authenticated, public;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'controlai\_api\_%'
            or p.proname in ('controlai_get_api_token', 'controlai_rotate_api_token'))
  loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;
