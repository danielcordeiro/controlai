-- ============================================================================
-- Controlaí — relatório de uso
--
-- O app NÃO cria tabela de analytics: reaproveita public.analytics_events e a
-- função public.track() que o Rachaí já tem neste mesmo projeto, gravando os
-- eventos com o nome prefixado ("controlai:pageview", "controlai:lancar_despesa",
-- "controlai:criar_carteira", "controlai:exportar_csv").
--
-- Este arquivo só separa os RELATÓRIOS, porque total_events e unique_sessions do
-- analytics_summary somavam os dois apps e inflavam os números do Rachaí.
-- Rodar no SQL Editor. Idempotente.
-- ============================================================================

-- Rachaí: volta a medir só o Rachaí.
create or replace function public.analytics_summary(p_days integer default 7)
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  with win as (
    select * from analytics_events
    where created_at >= now() - (greatest(coalesce(p_days, 7), 1) || ' days')::interval
      and name not like 'controlai:%'
  )
  select json_build_object(
    'days', greatest(coalesce(p_days, 7), 1),
    'total_events', (select count(*) from win),
    'unique_sessions', (select count(distinct session_id) from win where session_id <> ''),
    'by_name', coalesce((
      select json_object_agg(name, c)
      from (select name, count(*) c from win group by name order by count(*) desc) t
    ), '{}'::json),
    'by_day', coalesce((
      select json_agg(json_build_object('day', d, 'events', c, 'sessions', s) order by d)
      from (
        select date_trunc('day', created_at)::date d, count(*) c, count(distinct session_id) s
        from win group by 1
      ) t
    ), '[]'::json)
  );
$$;

-- Controlaí: o espelho, só com os eventos prefixados.
create or replace function public.controlai_analytics_summary(p_days integer default 7)
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  with win as (
    select * from analytics_events
    where created_at >= now() - (greatest(coalesce(p_days, 7), 1) || ' days')::interval
      and name like 'controlai:%'
  )
  select json_build_object(
    'days', greatest(coalesce(p_days, 7), 1),
    'total_events', (select count(*) from win),
    'unique_sessions', (select count(distinct session_id) from win where session_id <> ''),
    'by_name', coalesce((
      select json_object_agg(name, c)
      from (select name, count(*) c from win group by name order by count(*) desc) t
    ), '{}'::json),
    'by_day', coalesce((
      select json_agg(json_build_object('day', d, 'events', c, 'sessions', s) order by d)
      from (
        select date_trunc('day', created_at)::date d, count(*) c, count(distinct session_id) s
        from win group by 1
      ) t
    ), '[]'::json)
  );
$$;

-- Métrica é dado interno: só com a chave secreta do projeto (service_role).
revoke all on function public.analytics_summary(integer)           from anon, authenticated, public;
revoke all on function public.controlai_analytics_summary(integer) from anon, authenticated, public;
grant execute on function public.analytics_summary(integer)           to service_role;
grant execute on function public.controlai_analytics_summary(integer) to service_role;
