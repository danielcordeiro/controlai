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
  select c.id into v_id from controlai.category c
   where c.ledger_id = p_ledger and not c.archived
     and controlai.unaccent_simples(c.name) = controlai.unaccent_simples(v_nome)
   limit 1;
  if v_id is null then
    select c.id into v_id from controlai.category c
     where c.ledger_id = p_ledger and not c.archived
       and controlai.unaccent_simples(c.name) like controlai.unaccent_simples(v_nome) || '%'
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
  return json_build_object(
    'carteira', (select l.name from controlai.ledger l where l.id = v_ledger),
    'hoje', to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
    'mes_atual', to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM'),
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

create or replace function public.controlai_api_lancar(
  p_token text, p_valor numeric, p_categoria text,
  p_data text default null, p_forma text default null, p_descricao text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_cat uuid; v_forma uuid; v_data date; v_cents integer; v_id uuid;
begin
  v_ledger := controlai._por_token(p_token);
  if p_valor is null or p_valor <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  v_cents := round(p_valor * 100)::integer;
  if v_cents > 2147483647 then
    raise exception 'Valor grande demais.';
  end if;
  v_cat   := controlai._categoria_por_nome(v_ledger, p_categoria);
  v_forma := controlai._forma_por_nome(v_ledger, p_forma);
  v_data  := coalesce(nullif(btrim(coalesce(p_data, '')), '')::date,
                      (now() at time zone 'America/Sao_Paulo')::date);
  if v_data > (now() at time zone 'America/Sao_Paulo')::date + 1 then
    raise exception 'A data não pode ser no futuro.';
  end if;
  insert into controlai.expense (ledger_id, spent_on, amount_cents, category_id, payment_method_id, description)
  values (v_ledger, v_data, v_cents, v_cat, v_forma, left(coalesce(btrim(p_descricao), ''), 140))
  returning id into v_id;
  return json_build_object(
    'ok', true, 'id', v_id,
    'data', to_char(v_data, 'YYYY-MM-DD'),
    'valor', round(v_cents / 100.0, 2),
    'categoria', (select name from controlai.category where id = v_cat),
    'forma_pagamento', (select name from controlai.payment_method where id = v_forma),
    'descricao', left(coalesce(btrim(p_descricao), ''), 140));
end;
$$;

create or replace function public.controlai_api_resumo(p_token text, p_mes text default null)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_ini date; v_fim date; v_total bigint; v_ant bigint;
begin
  v_ledger := controlai._por_token(p_token);
  v_ini := controlai._mes_inicio(p_mes);
  v_fim := (v_ini + interval '1 month')::date;
  v_total := controlai._total_mes(v_ledger, v_ini);
  v_ant   := controlai._total_mes(v_ledger, (v_ini - interval '1 month')::date);
  return json_build_object(
    'mes', to_char(v_ini, 'YYYY-MM'),
    'total', round(v_total / 100.0, 2),
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
               group by 1) t), '[]'::json));
end;
$$;

create or replace function public.controlai_api_listar(
  p_token text, p_mes text default null, p_categoria text default null, p_limite integer default 50)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_ini date; v_fim date; v_cat uuid;
begin
  v_ledger := controlai._por_token(p_token);
  v_ini := controlai._mes_inicio(p_mes);
  v_fim := (v_ini + interval '1 month')::date;
  if coalesce(btrim(p_categoria), '') <> '' then
    v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
  end if;
  return coalesce((
    select json_agg(json_build_object(
             'id', e.id, 'data', to_char(e.spent_on, 'YYYY-MM-DD'),
             'valor', round(e.amount_cents / 100.0, 2),
             'categoria', c.name, 'forma_pagamento', m.name,
             'descricao', nullif(e.description, ''))
           order by e.spent_on desc, e.created_at desc)
      from controlai.expense e
      left join controlai.category c on c.id = e.category_id
      left join controlai.payment_method m on m.id = e.payment_method_id
     where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim
       and (v_cat is null or e.category_id = v_cat or c.parent_id = v_cat)
     limit greatest(1, least(coalesce(p_limite, 50), 200))), '[]'::json);
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
    if p_valor <= 0 then raise exception 'O valor precisa ser maior que zero.'; end if;
    v_cents := round(p_valor * 100)::integer;
  end if;
  if coalesce(btrim(p_categoria), '') <> '' then
    v_cat := controlai._categoria_por_nome(v_ledger, p_categoria);
  end if;
  if coalesce(btrim(p_data), '') <> '' then v_data := p_data::date; end if;
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
  return json_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.controlai_api_apagar(p_token text, p_id uuid)
returns json language plpgsql security definer set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._por_token(p_token);
  perform controlai._pertence(v_ledger, 'expense', p_id);
  delete from controlai.expense where id = p_id and ledger_id = v_ledger;
  return json_build_object('ok', true);
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
