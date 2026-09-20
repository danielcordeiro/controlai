-- ============================================================================
-- Controlaí — despesas fixas (recorrentes)
--
-- Ordem de aplicação: schema.sql -> fixas.sql -> api-ia.sql -> analytics.sql.
-- As funções de schema.sql já chamam o que está aqui (corpo plpgsql não resolve
-- nomes na criação), então cada objeto tem UMA definição só, num arquivo só.
--
-- Ideia central: a fixa é uma REGRA, não um monte de lançamento futuro.
-- As ocorrências nascem sob demanda, uma por mês, quando aquele mês é aberto —
-- nunca à frente do mês corrente. Assim o mês que vem não fica "pré-gasto",
-- e mudar o valor da fixa hoje não reescreve o passado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tabelas
-- ----------------------------------------------------------------------------
create table if not exists controlai.recurring (
  id                uuid primary key default gen_random_uuid(),
  ledger_id         uuid not null references controlai.ledger(id)
                      on update cascade on delete cascade,
  description       text not null default '',
  amount_cents      integer not null check (amount_cents > 0),
  category_id       uuid not null references controlai.category(id) on delete restrict,
  payment_method_id uuid references controlai.payment_method(id) on delete set null,
  dia               integer not null default 1 check (dia between 1 and 31),
  mes_inicio        text not null,   -- 'AAAA-MM': primeiro mês em que aparece
  total_meses       integer,         -- null = indeterminado (até cancelar)
  cancelado_em      text,            -- 'AAAA-MM': não gera deste mês em diante
  created_at        timestamptz not null default now()
);
-- (ledger_id, mes_inicio) serve o min() do catch-up como index-only scan
create index if not exists recurring_ledger_idx  on controlai.recurring (ledger_id, mes_inicio);
-- o lado filho das FKs: sem isto, excluir categoria ou forma varre a tabela toda
create index if not exists recurring_categoria_idx on controlai.recurring (category_id);
create index if not exists recurring_forma_idx     on controlai.recurring (payment_method_id);

-- "apaguei a ocorrência deste mês" — a fixa continua, só este mês fica de fora
create table if not exists controlai.recurring_skip (
  recurring_id uuid not null references controlai.recurring(id) on delete cascade,
  month_key    text not null,
  primary key (recurring_id, month_key)
);

-- Liga o lançamento à fixa que o gerou. Uma ocorrência por (fixa, mês).
alter table controlai.expense add column if not exists recurring_id uuid
  references controlai.recurring(id) on delete set null;
alter table controlai.expense add column if not exists recurring_month text;
create unique index if not exists expense_recurring_unq
  on controlai.expense (recurring_id, recurring_month) where recurring_id is not null;

-- Até que mês as ocorrências já foram materializadas nesta carteira. Evita
-- varrer o histórico inteiro a cada abertura do app.
alter table controlai.ledger add column if not exists fixas_ate text;

alter table controlai.recurring      enable row level security;
alter table controlai.recurring_skip enable row level security;

-- ----------------------------------------------------------------------------
-- Funções internas
-- ----------------------------------------------------------------------------
create or replace function controlai._mes_add(p_mes text, p_n integer)
returns text language sql immutable set search_path = pg_temp as $$
  select to_char(to_date(p_mes || '-01', 'YYYY-MM-DD') + (p_n || ' month')::interval, 'YYYY-MM');
$$;

-- Último mês em que a fixa ainda aparece (null = sem fim previsto).
-- least() ignora null, e _mes_add propaga null: sem prazo e sem cancelamento
-- o resultado é null, que é exatamente "não tem fim".
create or replace function controlai._fixa_ultimo_mes(p controlai.recurring)
returns text language sql immutable set search_path = controlai, pg_temp as $$
  select least(controlai._mes_add(p.mes_inicio, p.total_meses - 1),
               controlai._mes_add(p.cancelado_em, -1));
$$;

-- "Ainda vai lançar?" — a definição que o app e o conector precisam concordar.
create or replace function controlai._fixa_ativa(p controlai.recurring)
returns boolean language sql stable set search_path = controlai, pg_temp as $$
  select p.cancelado_em is null
     and (controlai._fixa_ultimo_mes(p) is null
          or controlai._fixa_ultimo_mes(p) >= controlai._mes_atual());
$$;

-- Materializa as ocorrências de um mês. Idempotente: o índice único
-- expense_recurring_unq é quem garante uma por (fixa, mês), então aqui não há
-- pré-checagem na expense — o `on conflict do nothing` já resolve.
create or replace function controlai._gerar_fixas(p_ledger uuid, p_mes text)
returns integer language plpgsql set search_path = controlai, public, pg_temp as $$
declare
  r       controlai.recurring;
  v_dia   integer;
  v_data  date;
  v_hoje  date := controlai._hoje();
  v_fim   text;
  v_qtd   integer := 0;
begin
  if p_mes > controlai._mes_atual() then
    return 0;   -- nunca lança no futuro
  end if;

  for r in
    select * from controlai.recurring
     where ledger_id = p_ledger
       and mes_inicio <= p_mes
       and (cancelado_em is null or p_mes < cancelado_em)
  loop
    v_fim := controlai._fixa_ultimo_mes(r);
    continue when v_fim is not null and p_mes > v_fim;
    continue when exists (select 1 from controlai.recurring_skip s
                           where s.recurring_id = r.id and s.month_key = p_mes);

    -- dia 31 em mês de 30 cai no último dia, não vaza para o mês seguinte
    v_dia := least(r.dia, extract(day from (to_date(p_mes || '-01', 'YYYY-MM-DD')
                                            + interval '1 month - 1 day'))::integer);
    v_data := to_date(p_mes || '-' || lpad(v_dia::text, 2, '0'), 'YYYY-MM-DD');
    -- a ocorrência do mês corrente não pode nascer com data futura
    v_data := least(v_data, v_hoje);

    insert into controlai.expense
      (ledger_id, spent_on, amount_cents, category_id, payment_method_id, description,
       recurring_id, recurring_month)
    values (p_ledger, v_data, r.amount_cents, r.category_id, r.payment_method_id,
            r.description, r.id, p_mes)
    on conflict do nothing;
    if found then v_qtd := v_qtd + 1; end if;
  end loop;

  return v_qtd;
end;
$$;

-- Põe em dia TODOS os meses pendentes, do mais antigo até o mês corrente.
-- Sem isso, o total do mês anterior e a lista de meses com gasto ignorariam as
-- fixas de qualquer mês que a pessoa nunca tenha aberto na tela.
-- `p_desde` faz o catch-up descer até um mês específico (fixa criada no passado)
-- sem precisar invalidar o marcador e revarrer o histórico inteiro.
create or replace function controlai._catchup_fixas(p_ledger uuid, p_desde text default null)
returns void language plpgsql set search_path = controlai, public, pg_temp as $$
declare
  v_atual text := controlai._mes_atual();
  v_ate text; v_desde text; v_m text; v_n integer := 0;
begin
  -- a linha da ledger já está no buffer (o gate acabou de lê-la); o min() na
  -- recurring é a consulta cara, então só roda quando há mesmo o que fazer
  select fixas_ate into v_ate from controlai.ledger where id = p_ledger;
  if v_ate is not null and v_ate >= v_atual and p_desde is null then return; end if;

  select min(mes_inicio) into v_desde from controlai.recurring where ledger_id = p_ledger;
  if v_desde is null then return; end if;
  if v_ate is not null and controlai._mes_add(v_ate, 1) > v_desde then
    v_desde := controlai._mes_add(v_ate, 1);
  end if;
  v_desde := least(v_desde, p_desde);   -- least ignora null

  v_m := v_desde;
  while v_m <= v_atual and v_n < 240 loop
    perform controlai._gerar_fixas(p_ledger, v_m);
    v_m := controlai._mes_add(v_m, 1);
    v_n := v_n + 1;
  end loop;

  -- grava só o que foi realmente percorrido: se o teto de 240 parou o laço,
  -- a próxima chamada continua de onde parou em vez de pular meses
  if v_n > 0 then
    update controlai.ledger set fixas_ate = controlai._mes_add(v_m, -1) where id = p_ledger;
  end if;
end;
$$;

-- Mudar a data de uma ocorrência para outro mês a solta da série. Sem isso o
-- lançamento continuaria marcado como "a ocorrência de setembro" estando em
-- agosto: setembro nunca mais seria gerado e agosto ficaria com dois.
create or replace function controlai._solta_da_fixa(p_expense uuid)
returns void language plpgsql set search_path = controlai, public, pg_temp as $$
declare v_rec uuid; v_mes text; v_novo text;
begin
  select recurring_id, recurring_month, to_char(spent_on, 'YYYY-MM')
    into v_rec, v_mes, v_novo
    from controlai.expense where id = p_expense;
  if v_rec is null or v_mes is null or v_mes = v_novo then return; end if;
  insert into controlai.recurring_skip (recurring_id, month_key)
  values (v_rec, v_mes) on conflict do nothing;
  update controlai.expense set recurring_id = null, recurring_month = null
   where id = p_expense;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPCs do app
-- ----------------------------------------------------------------------------
create or replace function public.controlai_add_fixa(
  p_ledger uuid, p_descricao text, p_amount_cents integer, p_category uuid,
  p_dia integer, p_mes_inicio text default null, p_total_meses integer default null,
  p_payment_method uuid default null)
returns uuid language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_id uuid; v_inicio text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  perform controlai._pertence(v_ledger, 'category', p_category);
  if p_payment_method is not null then
    perform controlai._pertence(v_ledger, 'payment_method', p_payment_method);
  end if;
  if p_dia is null or p_dia < 1 or p_dia > 31 then
    raise exception 'O dia precisa estar entre 1 e 31.';
  end if;
  if p_total_meses is not null and p_total_meses < 1 then
    raise exception 'A quantidade de meses precisa ser pelo menos 1.';
  end if;
  v_inicio := coalesce(nullif(btrim(coalesce(p_mes_inicio, '')), ''), controlai._mes_atual());
  if v_inicio !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Mês de início inválido (use AAAA-MM).';
  end if;

  insert into controlai.recurring
    (ledger_id, description, amount_cents, category_id, payment_method_id, dia, mes_inicio, total_meses)
  values (v_ledger, left(coalesce(btrim(p_descricao), ''), 140), p_amount_cents, p_category,
          p_payment_method, p_dia, v_inicio, p_total_meses)
  returning id into v_id;

  -- a fixa pode começar num mês já passado: o catch-up desce até lá
  perform controlai._catchup_fixas(v_ledger, v_inicio);

  return v_id;
end;
$$;

create or replace function public.controlai_update_fixa(
  p_ledger uuid, p_fixa uuid, p_descricao text, p_amount_cents integer,
  p_category uuid, p_dia integer, p_total_meses integer default null,
  p_payment_method uuid default null)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if not exists (select 1 from controlai.recurring where id = p_fixa and ledger_id = v_ledger) then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if p_dia is null or p_dia < 1 or p_dia > 31 then
    raise exception 'O dia precisa estar entre 1 e 31.';
  end if;
  if p_total_meses is not null and p_total_meses < 1 then
    raise exception 'A quantidade de meses precisa ser pelo menos 1.';
  end if;
  perform controlai._pertence(v_ledger, 'category', p_category);
  if p_payment_method is not null then
    perform controlai._pertence(v_ledger, 'payment_method', p_payment_method);
  end if;
  -- muda daqui para frente; as ocorrências já lançadas ficam como estão
  update controlai.recurring
     set description = left(coalesce(btrim(p_descricao), ''), 140),
         amount_cents = p_amount_cents,
         category_id = p_category,
         payment_method_id = p_payment_method,
         dia = p_dia,
         total_meses = p_total_meses
   where id = p_fixa and ledger_id = v_ledger;
end;
$$;

-- Cancelar não apaga: para de gerar do mês indicado (padrão: o mês que vem).
create or replace function public.controlai_cancelar_fixa(
  p_ledger uuid, p_fixa uuid, p_a_partir_de text default null)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_mes text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if not exists (select 1 from controlai.recurring where id = p_fixa and ledger_id = v_ledger) then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  v_mes := coalesce(nullif(btrim(coalesce(p_a_partir_de, '')), ''),
                    controlai._mes_add(controlai._mes_atual(), 1));
  if v_mes !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Mês inválido (use AAAA-MM).';
  end if;
  update controlai.recurring set cancelado_em = v_mes where id = p_fixa and ledger_id = v_ledger;
end;
$$;

-- Reativar olha para a frente: os meses em que a fixa esteve parada continuam
-- parados. Sem os skips, limpar cancelado_em faria meses antigos brotarem de
-- uma vez na próxima abertura do app. O mês corrente volta a valer.
create or replace function public.controlai_reativar_fixa(p_ledger uuid, p_fixa uuid)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_canc text; v_atual text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  select cancelado_em into v_canc from controlai.recurring
   where id = p_fixa and ledger_id = v_ledger;
  if not found then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  if v_canc is null then return; end if;   -- já está ativa

  v_atual := controlai._mes_atual();
  insert into controlai.recurring_skip (recurring_id, month_key)
  select p_fixa, to_char(m, 'YYYY-MM')
    from generate_series(to_date(v_canc  || '-01', 'YYYY-MM-DD'),
                         to_date(v_atual || '-01', 'YYYY-MM-DD') - interval '1 month',
                         interval '1 month') m
  on conflict do nothing;

  update controlai.recurring set cancelado_em = null where id = p_fixa and ledger_id = v_ledger;
  perform controlai._gerar_fixas(v_ledger, v_atual);
end;
$$;

-- Excluir a regra sem levar o histórico junto. Como a ocorrência do mês corrente
-- nasce na hora em que a fixa é criada, exigir "zero lançamentos" tornaria o
-- botão de excluir inútil para sempre: a saída é soltar as despesas da série.
create or replace function public.controlai_del_fixa(
  p_ledger uuid, p_fixa uuid, p_manter_lancamentos boolean default false)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_qtd integer;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if not exists (select 1 from controlai.recurring where id = p_fixa and ledger_id = v_ledger) then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  select count(*) into v_qtd from controlai.expense
   where recurring_id = p_fixa and ledger_id = v_ledger;
  if v_qtd > 0 and not coalesce(p_manter_lancamentos, false) then
    raise exception 'Esta fixa já lançou % despesa(s). Confirme que quer excluir a regra mantendo o histórico.', v_qtd;
  end if;
  update controlai.expense set recurring_id = null, recurring_month = null
   where recurring_id = p_fixa and ledger_id = v_ledger;
  delete from controlai.recurring where id = p_fixa and ledger_id = v_ledger;
end;
$$;

-- ----------------------------------------------------------------------------
-- Permissões
-- ----------------------------------------------------------------------------
revoke all on controlai.recurring, controlai.recurring_skip from anon, authenticated;

revoke all on function controlai._mes_add(text, integer)                    from anon, authenticated, public;
revoke all on function controlai._fixa_ultimo_mes(controlai.recurring)      from anon, authenticated, public;
revoke all on function controlai._fixa_ativa(controlai.recurring)           from anon, authenticated, public;
revoke all on function controlai._gerar_fixas(uuid, text)                   from anon, authenticated, public;
revoke all on function controlai._catchup_fixas(uuid, text)                 from anon, authenticated, public;
revoke all on function controlai._solta_da_fixa(uuid)                       from anon, authenticated, public;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'controlai\_%fixa%'
  loop
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end $$;

grant execute on function
  public.controlai_add_fixa(uuid, text, integer, uuid, integer, text, integer, uuid),
  public.controlai_update_fixa(uuid, uuid, text, integer, uuid, integer, integer, uuid),
  public.controlai_cancelar_fixa(uuid, uuid, text),
  public.controlai_reativar_fixa(uuid, uuid),
  public.controlai_del_fixa(uuid, uuid, boolean)
to anon, authenticated;
