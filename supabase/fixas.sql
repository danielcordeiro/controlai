-- ============================================================================
-- Controlaí — despesas fixas (recorrentes), parcelados e contas a pagar
--
-- Ordem de aplicação: schema.sql -> fixas.sql -> api-ia.sql -> analytics.sql.
-- As funções de schema.sql já chamam o que está aqui (corpo plpgsql não resolve
-- nomes na criação), então cada objeto tem UMA definição só, num arquivo só.
-- Já as funções `language sql` daqui têm o corpo validado na criação: cada uma
-- vem depois do que ela usa.
--
-- Ideia central: a fixa é uma REGRA, não um monte de lançamento futuro. O
-- parcelado é uma fixa com número de meses. As ocorrências só são GRAVADAS até
-- o mês corrente, quando o mês é aberto; o futuro é CALCULADO por
-- controlai._ocorrencias e aparece como previsto ("já comprometido"), nunca
-- como gasto. Assim o mês que vem não fica "pré-gasto", e mudar o valor da fixa
-- hoje não reescreve o passado. Pago ou a pagar é um fato da linha
-- (expense.a_pagar); a série só decide com que status a ocorrência nasce.
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

-- Pago ou a pagar é da LINHA: avulsa nasce paga; a ocorrência de série que pede
-- confirmação nasce a pagar. O parcial serve a lista de contas a pagar, que
-- toda abertura do app lê.
alter table controlai.expense add column if not exists a_pagar boolean not null default false;
create index if not exists expense_a_pagar_idx
  on controlai.expense (ledger_id, spent_on) where a_pagar;

-- confirmar: as ocorrências nascem a pagar (boleto, carnê). total_cents: o total
-- informado em "R$ 1.000 em 3x"; o servidor divide e a 1ª parcela leva o resto,
-- então total - parcela * N fica sempre entre 0 e N - 1.
alter table controlai.recurring add column if not exists confirmar boolean not null default false;
alter table controlai.recurring add column if not exists total_cents integer;
alter table controlai.recurring drop constraint if exists recurring_total_ok;
alter table controlai.recurring add constraint recurring_total_ok check (
  total_cents is null or (total_meses is not null
    and total_cents - amount_cents::bigint * total_meses between 0 and total_meses - 1));

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

-- O "3" de 3/10: a parcela que cai no mês. Nulo em série sem fim.
create or replace function controlai._parcela(p controlai.recurring, p_mes text)
returns integer language sql immutable set search_path = pg_temp as $$
  select case when p.total_meses is not null
              then (left(p_mes, 4)::integer * 12 + right(p_mes, 2)::integer)
                 - (left(p.mes_inicio, 4)::integer * 12 + right(p.mes_inicio, 2)::integer) + 1 end;
$$;

-- A ÚNICA definição de quais ocorrências as regras de uma carteira têm entre
-- dois meses (inclusive). Quem grava (_gerar_fixas) e quem só mostra o futuro
-- (previstas, andamento, IA) leem daqui, então nunca divergem.
-- - vence: o dia da série; 31 em mês de 30 cai no último dia, não vaza.
-- - a_pagar: só quando a série pede confirmação E a ocorrência vence a partir
--   do dia em que a série foi cadastrada. O que venceu antes é histórico e nasce
--   pago (o parcelamento cadastrado no meio, inclusive a parcela do mês que já
--   venceu). A data de cadastro usa o mesmo fuso de controlai._hoje().
-- - a 1ª parcela leva o resto da divisão do total (em bigint: parcela × N
--   estoura o integer mesmo quando não há total).
-- - p_recurring recorta uma série só: sem ele, o andamento de cada série
--   geraria os meses de todas as outras para depois jogá-los fora.
-- A assinatura ganhou p_recurring: sem o drop, o create viraria uma sobrecarga
-- e a chamada com três argumentos ficaria ambígua.
drop function if exists controlai._ocorrencias(uuid, text, text);
create or replace function controlai._ocorrencias(p_ledger uuid, p_de text, p_ate text,
                                                   p_recurring uuid default null)
returns table(recurring_id uuid, mes text, vence date, amount_cents integer, category_id uuid,
              payment_method_id uuid, description text, confirmar boolean, a_pagar boolean,
              parcela integer, parcelas integer)
language sql stable set search_path = controlai, pg_temp as $$
  select r.id, o.mes, o.vence,
         (r.amount_cents + case when o.parcela = 1
                                then coalesce(r.total_cents - r.amount_cents::bigint * r.total_meses, 0)
                                else 0 end)::integer,
         r.category_id, r.payment_method_id, r.description, r.confirmar,
         r.confirmar and o.vence >= (r.created_at at time zone 'America/Sao_Paulo')::date,
         o.parcela, r.total_meses
    from controlai.recurring r
   cross join lateral generate_series(
           to_date(greatest(r.mes_inicio, p_de) || '-01', 'YYYY-MM-DD')::timestamp,
           to_date(least(controlai._fixa_ultimo_mes(r), p_ate) || '-01', 'YYYY-MM-DD')::timestamp,
           interval '1 month') g(m)
   cross join lateral (
     select to_char(g.m, 'YYYY-MM') as mes,
            controlai._parcela(r, to_char(g.m, 'YYYY-MM')) as parcela,
            g.m::date + least(r.dia, extract(day from g.m + interval '1 month - 1 day')::integer) - 1
              as vence) o
   where r.ledger_id = p_ledger
     and (p_recurring is null or r.id = p_recurring)
     and not exists (select 1 from controlai.recurring_skip s
                      where s.recurring_id = r.id and s.month_key = o.mes);
$$;

-- Grava as ocorrências de um mês. Idempotente: o índice único
-- expense_recurring_unq é quem garante uma por (fixa, mês). Mês futuro não
-- grava nada: o futuro é calculado, nunca gravado.
create or replace function controlai._gerar_fixas(p_ledger uuid, p_mes text)
returns integer language sql set search_path = controlai, public, pg_temp as $$
  with novas as (
    insert into controlai.expense
      (ledger_id, spent_on, amount_cents, category_id, payment_method_id, description,
       recurring_id, recurring_month, a_pagar)
    select p_ledger, o.vence, o.amount_cents, o.category_id, o.payment_method_id, o.description,
           o.recurring_id, o.mes, o.a_pagar
      from controlai._ocorrencias(p_ledger, p_mes, p_mes) o
     where p_mes <= controlai._mes_atual()
    on conflict do nothing
    returning 1)
  select count(*)::integer from novas;
$$;

-- Andamento de uma série, sempre das linhas e de _ocorrencias, nunca de
-- N × valor (skip, quitação e reativação quebrariam a conta). Série sem fim não
-- tem futuras: o having descarta a linha e o left join devolve nulo.
create or replace function controlai._andamento(p controlai.recurring)
returns table(pagas integer, pendentes integer, pendentes_cents bigint,
              futuras integer, futuras_cents bigint)
language sql stable set search_path = controlai, pg_temp as $$
  select l.pagas, l.pendentes, l.pendentes_cents, f.futuras, f.futuras_cents
    from (select (count(*) filter (where not e.a_pagar))::integer as pagas,
                 (count(*) filter (where e.a_pagar))::integer as pendentes,
                 coalesce(sum(e.amount_cents) filter (where e.a_pagar), 0)::bigint as pendentes_cents
            from controlai.expense e where e.recurring_id = p.id) l
    left join (select count(*)::integer as futuras,
                      coalesce(sum(o.amount_cents), 0)::bigint as futuras_cents
                 from controlai._ocorrencias(p.ledger_id,
                                             controlai._mes_add(controlai._mes_atual(), 1),
                                             controlai._fixa_ultimo_mes(p), p.id) o
               having controlai._fixa_ultimo_mes(p) is not null) f on true;
$$;

-- As ocorrências de um mês no formato de uma despesa, sem id: o que a tela
-- mostra como previsto. `p_so_a_pagar` recorta as que vão pedir confirmação.
create or replace function controlai._previstas(p_ledger uuid, p_mes text,
                                                 p_so_a_pagar boolean default false)
returns json language sql stable set search_path = controlai, pg_temp as $$
  select coalesce(json_agg(json_build_object(
           'spent_on', to_char(o.vence, 'YYYY-MM-DD'), 'amount_cents', o.amount_cents,
           'category_id', o.category_id, 'payment_method_id', o.payment_method_id,
           'description', o.description, 'recurring_id', o.recurring_id,
           'recurring_month', o.mes, 'a_pagar', o.a_pagar,
           'parcela', o.parcela, 'parcelas', o.parcelas, 'prevista', true)
         order by o.vence, o.description), '[]'::json)
    from controlai._ocorrencias(p_ledger, p_mes, p_mes) o
   where o.a_pagar or not p_so_a_pagar;
$$;

-- A ÚNICA definição do gasto contra o limite, do livre, da projeção e da média
-- por dia: o app lê de controlai_mes e a IA de api_resumo e api_lancar.
-- - Uma linha de total (category_id nulo, limite talvez nulo) e uma por
--   categoria de 1º nível com limite vigente, mesmo sem gasto. A subcategoria
--   soma no pai, pela regra coalesce(parent_id, id) de porCategoria.
-- - gasto: TODAS as linhas do mês, pagas e a pagar, avulsas e de série; no
--   total é o _total_mes. previsto: as ocorrências, só em mês futuro. Nos
--   demais, _ocorrencias devolve o que já está gravado e contaria em dobro.
-- - série: linha com recurring_id ou recurring_month (a solta de uma regra
--   excluída guarda o mês e continua acontecendo uma vez por mês).
-- - Projeção e média só no total, e só a avulsa é extrapolada. A média do mês
--   corrente é uma divisão só, exata em numeric, para não arredondar duas vezes.
-- - "Mês corrente" é o de p_hoje: os checks fixam o dia.
create or replace function controlai._orcamento(p_ledger uuid, p_mes text,
                                                 p_hoje date default controlai._hoje())
returns table(category_id uuid, limite_cents integer, gasto_cents bigint, serie_cents bigint,
              previsto_cents bigint, livre_cents bigint, livre_dia_cents bigint,
              projecao_cents bigint, media_dia_cents bigint)
language sql stable set search_path = controlai, pg_temp as $$
  with m as (
    select to_date(p_mes || '-01', 'YYYY-MM-DD') as ini,
           extract(day from to_date(p_mes || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::integer as dias,
           extract(day from p_hoje)::integer as d,
           p_mes = to_char(p_hoje, 'YYYY-MM') as corrente,
           p_mes > to_char(p_hoje, 'YYYY-MM') as futuro),
  itens as (   -- as linhas do mês e as previstas, já no topo da categoria
    select coalesce(c.parent_id, e.category_id) as topo, e.amount_cents as cents,
           (e.recurring_id is not null or e.recurring_month is not null) as serie, false as previsto
      from m, controlai.expense e
      left join controlai.category c on c.id = e.category_id
     where e.ledger_id = p_ledger
       and e.spent_on >= m.ini and e.spent_on < (m.ini + interval '1 month')::date
    union all
    select coalesce(c.parent_id, o.category_id), o.amount_cents, false, true
      from controlai._ocorrencias(p_ledger, p_mes, p_mes) o
      left join controlai.category c on c.id = o.category_id
     where p_mes > to_char(p_hoje, 'YYYY-MM')),
  lim as (select * from controlai._limites(p_ledger, p_mes)),
  alvos as (
    select null::uuid as alvo, (select l.limite_cents from lim l where l.category_id is null) as limite
    union all
    select l.category_id, l.limite_cents from lim l where l.category_id is not null),
  s as (
    select a.alvo, a.limite,
           coalesce(sum(i.cents) filter (where not i.previsto), 0)::bigint as gasto,
           coalesce(sum(i.cents) filter (where i.serie), 0)::bigint as serie,
           coalesce(sum(i.cents) filter (where i.previsto), 0)::bigint as previsto
      from alvos a
      left join itens i on a.alvo is null or i.topo = a.alvo
     group by a.alvo, a.limite)
  select s.alvo, s.limite, s.gasto, s.serie, s.previsto,
         s.limite - s.gasto - s.previsto,
         -- divisão inteira de não negativo: floor
         case when m.corrente and s.limite is not null
              then greatest(s.limite - s.gasto - s.previsto, 0) / (m.dias - m.d + 1) end,
         case when s.alvo is null and m.corrente and m.d >= 7
              then s.serie + round((s.gasto - s.serie) * m.dias / m.d::numeric)::bigint end,
         case when s.alvo is not null or m.futuro then null
              when m.corrente
              then round((s.serie * m.d + (s.gasto - s.serie) * m.dias) / (m.dias * m.d)::numeric)::bigint
              else round(s.gasto / m.dias::numeric)::bigint end
    from s, m;
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
-- (Linha a pagar não chega aqui mudando de mês: controlai._data_ok recusa.)
-- A linha já solta pela exclusão da fixa também perde o recurring_month: fora
-- do mês dela, deixa de ter nascido de série e não volta mais para a pagar.
create or replace function controlai._solta_da_fixa(p_expense uuid)
returns void language plpgsql set search_path = controlai, public, pg_temp as $$
declare v_rec uuid; v_mes text; v_novo text;
begin
  select recurring_id, recurring_month, to_char(spent_on, 'YYYY-MM')
    into v_rec, v_mes, v_novo
    from controlai.expense where id = p_expense;
  if v_mes is null or v_mes = v_novo then return; end if;
  if v_rec is not null then
    insert into controlai.recurring_skip (recurring_id, month_key)
    values (v_rec, v_mes) on conflict do nothing;
  end if;
  update controlai.expense set recurring_id = null, recurring_month = null
   where id = p_expense;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPCs do app
-- ----------------------------------------------------------------------------

-- As assinaturas ganharam parâmetros no fim: sem o drop, o create viraria uma
-- sobrecarga e a chamada por nome ficaria ambígua no PostgREST.
drop function if exists public.controlai_add_fixa(uuid, text, integer, uuid, integer, text, integer, uuid);
drop function if exists public.controlai_update_fixa(uuid, uuid, text, integer, uuid, integer, integer, uuid);
drop function if exists public.controlai_del_fixa(uuid, uuid, boolean);

-- Exatamente um de p_amount_cents (valor da parcela) e p_total_cents (o total,
-- que exige o número de meses; o servidor divide).
create or replace function public.controlai_add_fixa(
  p_ledger uuid, p_descricao text, p_amount_cents integer, p_category uuid,
  p_dia integer, p_mes_inicio text default null, p_total_meses integer default null,
  p_payment_method uuid default null, p_confirmar boolean default false,
  p_total_cents integer default null)
returns uuid language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_id uuid; v_inicio text; v_cents integer;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if p_amount_cents is not null and p_total_cents is not null then
    raise exception 'Informe o valor da parcela ou o valor total, não os dois.';
  end if;
  v_cents := coalesce(p_amount_cents, p_total_cents);
  if v_cents is null or v_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  perform controlai._pertence(v_ledger, 'category', p_category);
  if p_payment_method is not null then
    perform controlai._pertence(v_ledger, 'payment_method', p_payment_method);
  end if;
  if p_dia is null or p_dia < 1 or p_dia > 31 then
    raise exception 'O dia precisa estar entre 1 e 31.';
  end if;
  if p_total_meses is not null and (p_total_meses < 1 or p_total_meses > 600) then
    raise exception 'A quantidade de meses precisa ficar entre 1 e 600.';
  end if;
  if p_amount_cents::bigint * p_total_meses > 2147483647 then
    raise exception 'Valor total grande demais: confira se informou o valor da parcela ou o total.';
  end if;
  if p_total_cents is not null then
    if p_total_meses is null then
      raise exception 'Valor total só vale para parcelado: informe em quantas vezes.';
    end if;
    v_cents := p_total_cents / p_total_meses;   -- a 1ª parcela leva o resto
    if v_cents = 0 then
      raise exception 'O total precisa dar pelo menos R$ 0,01 por parcela.';
    end if;
  end if;
  v_inicio := coalesce(nullif(btrim(coalesce(p_mes_inicio, '')), ''), controlai._mes_atual());
  if v_inicio !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Mês de início inválido (use AAAA-MM).';
  end if;
  -- o catch-up anda no máximo 240 meses por chamada: começar antes disso o
  -- faria gravar fixas_ate no passado
  if v_inicio < controlai._mes_add(controlai._mes_atual(), -239) then
    raise exception 'O início é antigo demais (até 20 anos atrás).';
  end if;

  insert into controlai.recurring
    (ledger_id, description, amount_cents, category_id, payment_method_id, dia, mes_inicio,
     total_meses, confirmar, total_cents)
  values (v_ledger, left(coalesce(btrim(p_descricao), ''), 140), v_cents, p_category,
          p_payment_method, p_dia, v_inicio, p_total_meses, coalesce(p_confirmar, false),
          p_total_cents)
  returning id into v_id;

  -- a fixa pode começar num mês já passado: o catch-up desce até lá
  perform controlai._catchup_fixas(v_ledger, v_inicio);

  return v_id;
end;
$$;

-- p_confirmar nulo mantém: uma edição de valor nunca desliga a confirmação sem
-- ninguém pedir.
create or replace function public.controlai_update_fixa(
  p_ledger uuid, p_fixa uuid, p_descricao text, p_amount_cents integer,
  p_category uuid, p_dia integer, p_total_meses integer default null,
  p_payment_method uuid default null, p_confirmar boolean default null)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_inicio text; v_ultimo text;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  select mes_inicio into v_inicio from controlai.recurring where id = p_fixa and ledger_id = v_ledger;
  if not found then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'O valor precisa ser maior que zero.';
  end if;
  if p_dia is null or p_dia < 1 or p_dia > 31 then
    raise exception 'O dia precisa estar entre 1 e 31.';
  end if;
  if p_total_meses is not null and (p_total_meses < 1 or p_total_meses > 600) then
    raise exception 'A quantidade de meses precisa ficar entre 1 e 600.';
  end if;
  if p_amount_cents::bigint * p_total_meses > 2147483647 then
    raise exception 'Valor total grande demais: confira se informou o valor da parcela ou o total.';
  end if;
  -- encurtar para antes do que já foi lançado deixaria parcela "11 de 10"
  select max(recurring_month) into v_ultimo from controlai.expense
   where recurring_id = p_fixa and ledger_id = v_ledger;
  if v_ultimo > controlai._mes_add(v_inicio, p_total_meses - 1) then
    raise exception 'Esta série já tem lançamento depois da parcela %. Para encerrar antes, use cancelar.', p_total_meses;
  end if;
  perform controlai._pertence(v_ledger, 'category', p_category);
  if p_payment_method is not null then
    perform controlai._pertence(v_ledger, 'payment_method', p_payment_method);
  end if;
  -- muda daqui para frente; as ocorrências já lançadas ficam como estão.
  -- O total informado só vale enquanto a parcela e o N são os dele.
  update controlai.recurring
     set description = left(coalesce(btrim(p_descricao), ''), 140),
         amount_cents = p_amount_cents,
         category_id = p_category,
         payment_method_id = p_payment_method,
         dia = p_dia,
         total_meses = p_total_meses,
         confirmar = coalesce(p_confirmar, confirmar),
         total_cents = case when amount_cents = p_amount_cents
                             and total_meses is not distinct from p_total_meses
                            then total_cents end
   where id = p_fixa and ledger_id = v_ledger;

  -- aumentar o N de uma série que já tinha terminado a faz voltar a valer em
  -- meses que o marcador fixas_ate já deu por feitos
  perform controlai._catchup_fixas(v_ledger, v_inicio);
end;
$$;

-- Cancelar não apaga: para de gerar do mês indicado (padrão: o mês que vem).
-- As pendentes continuam pendentes: a dívida não some com a regra.
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

-- Excluir a regra. Como a ocorrência do mês corrente nasce na hora em que a fixa
-- é criada, exigir "zero lançamentos" tornaria o botão inútil para sempre: ou
-- se mantém o histórico (as linhas se soltam da série), ou — para quem
-- cadastrou errado — se apagam os lançamentos junto. Sem essa segunda saída,
-- recadastrar duplicaria os meses já lançados.
create or replace function public.controlai_del_fixa(
  p_ledger uuid, p_fixa uuid, p_manter_lancamentos boolean default false,
  p_apagar_lancamentos boolean default false)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_qtd integer;
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  if not exists (select 1 from controlai.recurring where id = p_fixa and ledger_id = v_ledger) then
    raise exception 'Esta despesa fixa não é desta carteira.';
  end if;
  if coalesce(p_apagar_lancamentos, false) then
    delete from controlai.expense where recurring_id = p_fixa and ledger_id = v_ledger;
  else
    select count(*) into v_qtd from controlai.expense
     where recurring_id = p_fixa and ledger_id = v_ledger;
    if v_qtd > 0 and not coalesce(p_manter_lancamentos, false) then
      raise exception 'Esta fixa já lançou % despesa(s). Confirme se quer manter o histórico ou apagar os lançamentos junto.', v_qtd;
    end if;
  end if;
  -- o que ficou se solta pela FK (on delete set null) e guarda o recurring_month:
  -- uma parcela pendente solta continua podendo ser marcada paga ou desmarcada
  delete from controlai.recurring where id = p_fixa and ledger_id = v_ledger;
end;
$$;

-- Pago/a pagar. Marcar paga vale para qualquer linha; voltar para a pagar só
-- para linha que nasceu de série (avulsa é sempre paga). A data do pagamento
-- não é guardada: a data da linha continua sendo o vencimento.
create or replace function public.controlai_marcar_pago(
  p_ledger uuid, p_expense uuid, p_pago boolean default true)
returns void language plpgsql security definer
set search_path = controlai, public, pg_temp as $$
declare v_ledger uuid; v_pago boolean := coalesce(p_pago, true);
begin
  v_ledger := controlai._ledger_ok(p_ledger);
  perform controlai._pertence(v_ledger, 'expense', p_expense);
  if not v_pago and exists (select 1 from controlai.expense
                             where id = p_expense and ledger_id = v_ledger
                               and recurring_month is null) then
    raise exception 'Despesa avulsa é sempre paga: só parcela ou fixa volta para a pagar.';
  end if;
  update controlai.expense set a_pagar = not v_pago, updated_at = now()
   where id = p_expense and ledger_id = v_ledger;
end;
$$;

-- ----------------------------------------------------------------------------
-- Permissões
-- ----------------------------------------------------------------------------
revoke all on controlai.recurring, controlai.recurring_skip from anon, authenticated;

revoke all on function controlai._mes_add(text, integer)                    from anon, authenticated, public;
revoke all on function controlai._fixa_ultimo_mes(controlai.recurring)      from anon, authenticated, public;
revoke all on function controlai._fixa_ativa(controlai.recurring)           from anon, authenticated, public;
revoke all on function controlai._parcela(controlai.recurring, text)        from anon, authenticated, public;
revoke all on function controlai._ocorrencias(uuid, text, text, uuid)       from anon, authenticated, public;
revoke all on function controlai._gerar_fixas(uuid, text)                   from anon, authenticated, public;
revoke all on function controlai._andamento(controlai.recurring)            from anon, authenticated, public;
revoke all on function controlai._previstas(uuid, text, boolean)            from anon, authenticated, public;
revoke all on function controlai._orcamento(uuid, text, date)               from anon, authenticated, public;
revoke all on function controlai._catchup_fixas(uuid, text)                 from anon, authenticated, public;
revoke all on function controlai._solta_da_fixa(uuid)                       from anon, authenticated, public;

-- todo controlai_* e não só as de fixa: controlai_marcar_pago também mora aqui
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'controlai\_%'
  loop
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end $$;

grant execute on function
  public.controlai_add_fixa(uuid, text, integer, uuid, integer, text, integer, uuid, boolean, integer),
  public.controlai_update_fixa(uuid, uuid, text, integer, uuid, integer, integer, uuid, boolean),
  public.controlai_cancelar_fixa(uuid, uuid, text),
  public.controlai_reativar_fixa(uuid, uuid),
  public.controlai_del_fixa(uuid, uuid, boolean, boolean),
  public.controlai_marcar_pago(uuid, uuid, boolean)
to anon, authenticated;
