-- ============================================================================
-- Controlaí — schema completo do Supabase
-- Rode este arquivo inteiro no SQL Editor do Supabase (uma vez).
-- Seguro para rodar de novo: usa IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.
--
-- MODELO DE SEGURANÇA (o mesmo do Rachaí, um passo mais restrito):
--   1. As TABELAS vivem no schema "controlai", que NÃO é exposto pelo PostgREST.
--      Mesmo que uma policy fosse criada por engano, a anon key não enxerga a
--      tabela pela API REST. Defesa em profundidade.
--   2. RLS ligada em todas as tabelas e NENHUMA policy pública.
--   3. Todo acesso passa pelas funções public.controlai_* (SECURITY DEFINER),
--      as únicas coisas com GRANT EXECUTE para anon/authenticated.
--
-- CONVIVÊNCIA COM O RACHAÍ: este projeto Supabase já hospeda o Rachaí, que tem
-- public.expenses, public.payments, add_expense(), get_event() etc. Por isso as
-- tabelas ficam fora do public e toda função leva o prefixo controlai_.
-- O analytics é reaproveitado: usamos o public.track() do Rachaí com nomes de
-- evento prefixados ("controlai:pageview"), sem criar tabela nova.
-- ============================================================================

create extension if not exists "pgcrypto";

create schema if not exists controlai;

-- ----------------------------------------------------------------------------
-- Tabelas
-- ----------------------------------------------------------------------------

-- Carteira: a unidade de acesso. O id (uuid v4) é a chave portadora — quem tem
-- o link entra. O e-mail existe só para RECUPERAR esse id (ver controlai_meus_ids).
create table if not exists controlai.ledger (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,                    -- normalizado (lower/btrim)
  currency      text not null default 'BRL',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists ledger_email_idx on controlai.ledger (email);

-- Plano de contas: até 2 níveis (categoria > subcategoria).
create table if not exists controlai.category (
  id         uuid primary key default gen_random_uuid(),
  ledger_id  uuid not null references controlai.ledger(id) on delete cascade,
  parent_id  uuid references controlai.category(id) on delete cascade,
  name       text not null,
  color      text not null default '#6366f1',
  sort_order integer not null default 100,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists category_ledger_idx on controlai.category (ledger_id);
create index if not exists category_parent_idx on controlai.category (parent_id);
-- nome único por nível dentro da carteira (case-insensitive)
create unique index if not exists category_nome_unq
  on controlai.category (ledger_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- Forma de pagamento (opcional na despesa).
create table if not exists controlai.payment_method (
  id         uuid primary key default gen_random_uuid(),
  ledger_id  uuid not null references controlai.ledger(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 100,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists payment_method_ledger_idx on controlai.payment_method (ledger_id);
create unique index if not exists payment_method_nome_unq
  on controlai.payment_method (ledger_id, lower(name));

-- Despesa: data + categoria (obrigatórias) + forma de pagamento (opcional).
create table if not exists controlai.expense (
  id                uuid primary key default gen_random_uuid(),
  ledger_id         uuid not null references controlai.ledger(id) on delete cascade,
  spent_on          date not null,
  amount_cents      integer not null check (amount_cents > 0),
  category_id       uuid not null references controlai.category(id) on delete restrict,
  payment_method_id uuid references controlai.payment_method(id) on delete set null,
  description       text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- índice que serve a consulta quente: despesas de UM mês de UMA carteira
create index if not exists expense_ledger_data_idx on controlai.expense (ledger_id, spent_on desc);
create index if not exists expense_category_idx    on controlai.expense (category_id);

-- ----------------------------------------------------------------------------
-- RLS ligada, sem policy pública: nada é legível/gravável direto pela anon key.
-- ----------------------------------------------------------------------------
alter table controlai.ledger         enable row level security;
alter table controlai.category       enable row level security;
alter table controlai.payment_method enable row level security;
alter table controlai.expense        enable row level security;

-- ============================================================================
-- Helpers internos (schema controlai, NÃO expostos)
-- ============================================================================

-- Valida o formato do e-mail e devolve normalizado; erro amigável se inválido.
create or replace function controlai._email_ok(p_email text)
returns text
language plpgsql
immutable
set search_path = controlai, public, pg_temp
as $$
declare v text;
begin
  v := lower(btrim(coalesce(p_email, '')));
  if v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Informe um e-mail válido.';
  end if;
  return v;
end;
$$;

-- Primeiro dia do mês a partir de 'YYYY-MM' (ou do mês corrente se vier vazio).
create or replace function controlai._mes_inicio(p_mes text)
returns date
language plpgsql
stable            -- usa now() quando o mês vem vazio, então NÃO é immutable
set search_path = controlai, public, pg_temp
as $$
begin
  if coalesce(btrim(p_mes), '') = '' then
    return date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  end if;
  if p_mes !~ '^\d{4}-\d{2}$' then
    raise exception 'Mês inválido (use AAAA-MM).';
  end if;
  return to_date(p_mes || '-01', 'YYYY-MM-DD');
end;
$$;

-- Garante que a carteira existe (e devolve o id). Erro claro se o link for velho.
create or replace function controlai._ledger_ok(p_ledger uuid)
returns uuid
language plpgsql
stable
set search_path = controlai, public, pg_temp
as $$
begin
  if p_ledger is null or not exists (select 1 from controlai.ledger where id = p_ledger) then
    raise exception 'Carteira não encontrada. Confira o link ou recupere seu ID pelo e-mail.';
  end if;
  return p_ledger;
end;
$$;

-- Total de um mês da carteira (usado na comparação com o mês anterior).
create or replace function controlai._total_mes(p_ledger uuid, p_inicio date)
returns bigint
language sql
stable
set search_path = controlai, public, pg_temp
as $$
  select coalesce(sum(amount_cents), 0)::bigint
    from controlai.expense
   where ledger_id = p_ledger
     and spent_on >= p_inicio
     and spent_on <  (p_inicio + interval '1 month')::date;
$$;

-- ============================================================================
-- RPCs públicas (gateway). SECURITY DEFINER => rodam como dono e ignoram a RLS.
-- ============================================================================

-- Criar carteira -------------------------------------------------------------
-- Semeia um plano de contas e formas de pagamento padrão para a pessoa já sair
-- lançando despesa, sem ter que cadastrar nada antes.
create or replace function public.controlai_criar(p_name text, p_email text)
returns json
language plpgsql
security definer
set search_path = controlai, public
as $$
declare
  v_id    uuid;
  v_email text;
  v_nome  text;
begin
  v_email := controlai._email_ok(p_email);
  v_nome  := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    v_nome := 'Minhas despesas';
  end if;
  if length(v_nome) > 80 then
    v_nome := left(v_nome, 80);
  end if;

  insert into controlai.ledger (name, email) values (v_nome, v_email) returning id into v_id;

  insert into controlai.category (ledger_id, name, color, sort_order) values
    (v_id, 'Moradia',      '#8b5cf6', 10),
    (v_id, 'Alimentação',  '#ef4444', 20),
    (v_id, 'Mercado',      '#f97316', 30),
    (v_id, 'Transporte',   '#3b82f6', 40),
    (v_id, 'Saúde',        '#10b981', 50),
    (v_id, 'Educação',     '#6366f1', 60),
    (v_id, 'Lazer',        '#ec4899', 70),
    (v_id, 'Assinaturas',  '#14b8a6', 80),
    (v_id, 'Pessoal',      '#a855f7', 90),
    (v_id, 'Outros',       '#9ca3af', 999);

  insert into controlai.payment_method (ledger_id, name, sort_order) values
    (v_id, 'Pix',                10),
    (v_id, 'Cartão de crédito',  20),
    (v_id, 'Cartão de débito',   30),
    (v_id, 'Dinheiro',           40),
    (v_id, 'Boleto',             50);

  return json_build_object('id', v_id, 'name', v_nome, 'email', v_email);
end;
$$;

-- Snapshot do mês ------------------------------------------------------------
-- Uma chamada só entrega tudo que a tela precisa: carteira, plano de contas,
-- formas, despesas DO MÊS, total do mês anterior (comparação) e os meses que
-- têm lançamento (para o seletor não oferecer mês vazio).
create or replace function public.controlai_mes(p_ledger uuid, p_mes text default null)
returns json
language plpgsql
security definer
set search_path = controlai, public
as $$
declare
  v_ledger uuid;
  v_ini    date;
  v_fim    date;
  v_out    json;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  v_ini    := controlai._mes_inicio(p_mes);
  v_fim    := (v_ini + interval '1 month')::date;

  -- marca presença no máximo 1x por hora (evita uma escrita por carregamento)
  update controlai.ledger
     set last_seen_at = now()
   where id = v_ledger and last_seen_at < now() - interval '1 hour';

  select json_build_object(
    'ledger', (select json_build_object('id', l.id, 'name', l.name, 'email', l.email,
                                        'currency', l.currency, 'created_at', l.created_at)
                 from controlai.ledger l where l.id = v_ledger),
    'mes', to_char(v_ini, 'YYYY-MM'),
    'categories', coalesce((
        select json_agg(json_build_object('id', c.id, 'name', c.name, 'color', c.color,
                                          'parent_id', c.parent_id, 'archived', c.archived,
                                          'sort_order', c.sort_order)
                        order by c.sort_order, lower(c.name))
          from controlai.category c where c.ledger_id = v_ledger), '[]'::json),
    'payment_methods', coalesce((
        select json_agg(json_build_object('id', m.id, 'name', m.name, 'archived', m.archived,
                                          'sort_order', m.sort_order)
                        order by m.sort_order, lower(m.name))
          from controlai.payment_method m where m.ledger_id = v_ledger), '[]'::json),
    'expenses', coalesce((
        select json_agg(json_build_object('id', e.id, 'spent_on', to_char(e.spent_on, 'YYYY-MM-DD'),
                                          'amount_cents', e.amount_cents, 'category_id', e.category_id,
                                          'payment_method_id', e.payment_method_id,
                                          'description', e.description)
                        order by e.spent_on desc, e.created_at desc)
          from controlai.expense e
         where e.ledger_id = v_ledger and e.spent_on >= v_ini and e.spent_on < v_fim), '[]'::json),
    'total_cents',      controlai._total_mes(v_ledger, v_ini),
    'total_anterior',   controlai._total_mes(v_ledger, (v_ini - interval '1 month')::date),
    'meses_com_gasto', coalesce((
        select json_agg(m order by m desc)
          from (select distinct to_char(e.spent_on, 'YYYY-MM') m
                  from controlai.expense e where e.ledger_id = v_ledger) t), '[]'::json)
  ) into v_out;

  return v_out;
end;
$$;

-- Recuperar o ID pelo e-mail -------------------------------------------------
-- Só responde para quem PROVOU ser dono da caixa de e-mail: o usuário entra por
-- link mágico / código enviado pelo Supabase Auth e o e-mail sai do JWT — nunca
-- de um campo digitado. Digitar o e-mail de outra pessoa não devolve nada.
create or replace function public.controlai_meus_ids()
returns json
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_email text;
begin
  v_email := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  if v_email = '' then
    raise exception 'Confirme o e-mail para recuperar seus IDs.';
  end if;

  return coalesce((
    select json_agg(json_build_object(
             'id', l.id, 'name', l.name,
             'created_at', l.created_at, 'last_seen_at', l.last_seen_at,
             'despesas', (select count(*) from controlai.expense e where e.ledger_id = l.id))
           order by l.last_seen_at desc)
      from controlai.ledger l
     where l.email = v_email), '[]'::json);
end;
$$;

-- Despesas -------------------------------------------------------------------
create or replace function public.controlai_add_despesa(
  p_ledger uuid, p_spent_on date, p_amount_cents integer, p_category uuid,
  p_payment_method uuid default null, p_description text default '')
returns uuid
language plpgsql
security definer
set search_path = controlai, public
as $$
declare
  v_ledger uuid;
  v_id     uuid;
begin
  v_ledger := controlai._ledger_ok(p_ledger);

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if p_spent_on is null then
    raise exception 'Informe a data da despesa.';
  end if;
  if p_spent_on > (now() at time zone 'America/Sao_Paulo')::date + 1 then
    raise exception 'A data não pode ser no futuro.';
  end if;
  -- a categoria PRECISA ser desta carteira (evita gravar em carteira alheia)
  if not exists (select 1 from controlai.category c
                  where c.id = p_category and c.ledger_id = v_ledger) then
    raise exception 'Escolha uma categoria da sua carteira.';
  end if;
  if p_payment_method is not null
     and not exists (select 1 from controlai.payment_method m
                      where m.id = p_payment_method and m.ledger_id = v_ledger) then
    raise exception 'Forma de pagamento inválida para esta carteira.';
  end if;

  insert into controlai.expense (ledger_id, spent_on, amount_cents, category_id,
                                 payment_method_id, description)
  values (v_ledger, p_spent_on, p_amount_cents, p_category, p_payment_method,
          left(coalesce(btrim(p_description), ''), 140))
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.controlai_update_despesa(
  p_expense uuid, p_spent_on date, p_amount_cents integer, p_category uuid,
  p_payment_method uuid default null, p_description text default '')
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_ledger uuid;
begin
  select ledger_id into v_ledger from controlai.expense where id = p_expense;
  if v_ledger is null then
    raise exception 'Despesa não encontrada.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if p_spent_on is null then
    raise exception 'Informe a data da despesa.';
  end if;
  if not exists (select 1 from controlai.category c
                  where c.id = p_category and c.ledger_id = v_ledger) then
    raise exception 'Escolha uma categoria da sua carteira.';
  end if;
  if p_payment_method is not null
     and not exists (select 1 from controlai.payment_method m
                      where m.id = p_payment_method and m.ledger_id = v_ledger) then
    raise exception 'Forma de pagamento inválida para esta carteira.';
  end if;

  update controlai.expense
     set spent_on = p_spent_on,
         amount_cents = p_amount_cents,
         category_id = p_category,
         payment_method_id = p_payment_method,
         description = left(coalesce(btrim(p_description), ''), 140),
         updated_at = now()
   where id = p_expense;
end;
$$;

create or replace function public.controlai_del_despesa(p_expense uuid)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
begin
  delete from controlai.expense where id = p_expense;
end;
$$;

-- Categorias (plano de contas) -----------------------------------------------
create or replace function public.controlai_add_categoria(
  p_ledger uuid, p_name text, p_parent uuid default null, p_color text default '#6366f1')
returns uuid
language plpgsql
security definer
set search_path = controlai, public
as $$
declare
  v_ledger uuid;
  v_id     uuid;
  v_nome   text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  v_nome := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    raise exception 'Dê um nome para a categoria.';
  end if;

  if p_parent is not null then
    -- pai precisa ser desta carteira e ser de primeiro nível (máximo 2 níveis)
    if not exists (select 1 from controlai.category c
                    where c.id = p_parent and c.ledger_id = v_ledger and c.parent_id is null) then
      raise exception 'A categoria pai é inválida (subcategoria não pode ter subcategoria).';
    end if;
  end if;

  insert into controlai.category (ledger_id, parent_id, name, color)
  values (v_ledger, p_parent, left(v_nome, 40), coalesce(nullif(btrim(p_color), ''), '#6366f1'))
  returning id into v_id;

  return v_id;
exception when unique_violation then
  raise exception 'Já existe uma categoria com esse nome aqui.';
end;
$$;

create or replace function public.controlai_update_categoria(
  p_category uuid, p_name text, p_color text default null, p_archived boolean default null)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_nome text;
begin
  v_nome := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    raise exception 'Dê um nome para a categoria.';
  end if;
  update controlai.category
     set name = left(v_nome, 40),
         color = coalesce(nullif(btrim(p_color), ''), color),
         archived = coalesce(p_archived, archived)
   where id = p_category;
exception when unique_violation then
  raise exception 'Já existe uma categoria com esse nome aqui.';
end;
$$;

-- Excluir só quando não há histórico; com histórico, o caminho é arquivar
-- (some do formulário e continua explicando os meses passados).
create or replace function public.controlai_del_categoria(p_category uuid)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
begin
  if exists (select 1 from controlai.expense where category_id = p_category) then
    raise exception 'Esta categoria já tem despesas. Arquive-a em vez de excluir (o histórico continua).';
  end if;
  if exists (select 1 from controlai.category where parent_id = p_category) then
    raise exception 'Esta categoria tem subcategorias. Exclua ou mova as subcategorias antes.';
  end if;
  delete from controlai.category where id = p_category;
end;
$$;

-- Formas de pagamento ---------------------------------------------------------
create or replace function public.controlai_add_forma(p_ledger uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = controlai, public
as $$
declare
  v_ledger uuid;
  v_id     uuid;
  v_nome   text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  v_nome := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    raise exception 'Dê um nome para a forma de pagamento.';
  end if;
  insert into controlai.payment_method (ledger_id, name)
  values (v_ledger, left(v_nome, 40)) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Já existe uma forma de pagamento com esse nome.';
end;
$$;

create or replace function public.controlai_update_forma(
  p_method uuid, p_name text, p_archived boolean default null)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_nome text;
begin
  v_nome := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    raise exception 'Dê um nome para a forma de pagamento.';
  end if;
  update controlai.payment_method
     set name = left(v_nome, 40),
         archived = coalesce(p_archived, archived)
   where id = p_method;
exception when unique_violation then
  raise exception 'Já existe uma forma de pagamento com esse nome.';
end;
$$;

-- A forma é opcional na despesa, então excluir apenas desvincula (ON DELETE SET NULL).
create or replace function public.controlai_del_forma(p_method uuid)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
begin
  delete from controlai.payment_method where id = p_method;
end;
$$;

-- Ajustes da carteira ---------------------------------------------------------
create or replace function public.controlai_renomear(p_ledger uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_nome text;
begin
  perform controlai._ledger_ok(p_ledger);
  v_nome := btrim(coalesce(p_name, ''));
  if v_nome = '' then
    raise exception 'Dê um nome para a carteira.';
  end if;
  update controlai.ledger set name = left(v_nome, 80) where id = p_ledger;
end;
$$;

create or replace function public.controlai_set_email(p_ledger uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = controlai, public
as $$
begin
  perform controlai._ledger_ok(p_ledger);
  update controlai.ledger set email = controlai._email_ok(p_email) where id = p_ledger;
end;
$$;

-- Exportação: todas as despesas da carteira (o CSV é montado no navegador).
create or replace function public.controlai_exportar(p_ledger uuid)
returns json
language plpgsql
security definer
set search_path = controlai, public
as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  return coalesce((
    select json_agg(json_build_object(
             'id', e.id, 'spent_on', to_char(e.spent_on, 'YYYY-MM-DD'),
             'amount_cents', e.amount_cents, 'category_id', e.category_id,
             'payment_method_id', e.payment_method_id, 'description', e.description)
           order by e.spent_on)
      from controlai.expense e where e.ledger_id = v_ledger), '[]'::json);
end;
$$;

-- ----------------------------------------------------------------------------
-- Permissões: anon/authenticated só podem EXECUTAR as funções acima.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema controlai from anon, authenticated;
revoke all on schema controlai from anon, authenticated;

grant execute on function
  public.controlai_criar(text, text),
  public.controlai_mes(uuid, text),
  public.controlai_meus_ids(),
  public.controlai_add_despesa(uuid, date, integer, uuid, uuid, text),
  public.controlai_update_despesa(uuid, date, integer, uuid, uuid, text),
  public.controlai_del_despesa(uuid),
  public.controlai_add_categoria(uuid, text, uuid, text),
  public.controlai_update_categoria(uuid, text, text, boolean),
  public.controlai_del_categoria(uuid),
  public.controlai_add_forma(uuid, text),
  public.controlai_update_forma(uuid, text, boolean),
  public.controlai_del_forma(uuid),
  public.controlai_renomear(uuid, text),
  public.controlai_set_email(uuid, text),
  public.controlai_exportar(uuid)
to anon, authenticated;

-- As funções internas do schema controlai não são chamáveis de fora.
revoke all on function controlai._email_ok(text)          from anon, authenticated, public;
revoke all on function controlai._mes_inicio(text)        from anon, authenticated, public;
revoke all on function controlai._ledger_ok(uuid)         from anon, authenticated, public;
revoke all on function controlai._total_mes(uuid, date)   from anon, authenticated, public;
