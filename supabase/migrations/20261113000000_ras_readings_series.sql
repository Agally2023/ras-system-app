-- Real readings for the dashboard graphs.
--  1. ras_tag_hourly: hourly roll-up of readings, so history is cheap to keep.
--  2. ras_rollup_readings(): moves completed hours from ras_tag_readings into ras_tag_hourly (called by the gateway).
--  3. ras_tags_series(): graph data for many tags at once, grouped by hour, day, ISO week (Monday start), month or year.
--  4. ras_seed_extra_tags(): water-quality analysers, valve positions and the per-jar sensors read over the RS-485 bus.

create table public.ras_tag_hourly (
  tag_id uuid not null references public.ras_plc_tags(id) on delete cascade,
  hour   timestamptz not null,
  sum_v  double precision not null,
  min_v  double precision not null,
  max_v  double precision not null,
  n      bigint not null,
  primary key (tag_id, hour)
);
alter table public.ras_tag_hourly enable row level security;
create policy ras_tag_hourly_read on public.ras_tag_hourly for select to authenticated using (true);

-- Gateway only (service role). Completed hours are summed into ras_tag_hourly, then the raw rows are removed.
create or replace function public.ras_rollup_readings()
returns bigint language plpgsql security invoker set search_path = '' as $$
declare moved bigint;
begin
  with del as (
    delete from public.ras_tag_readings
    where read_at < date_trunc('hour', now()) - interval '1 hour'
    returning tag_id, read_at, value
  ), agg as (
    insert into public.ras_tag_hourly (tag_id, hour, sum_v, min_v, max_v, n)
    select tag_id, date_trunc('hour', read_at), sum(value), min(value), max(value), count(*)
    from del where value is not null group by 1, 2
    on conflict (tag_id, hour) do update set
      sum_v = public.ras_tag_hourly.sum_v + excluded.sum_v,
      min_v = least(public.ras_tag_hourly.min_v, excluded.min_v),
      max_v = greatest(public.ras_tag_hourly.max_v, excluded.max_v),
      n     = public.ras_tag_hourly.n + excluded.n
    returning 1
  )
  select count(*) into moved from agg;
  return moved;
end $$;
revoke execute on function public.ras_rollup_readings() from public, anon, authenticated;
grant  execute on function public.ras_rollup_readings() to service_role;

-- p_bucket: 'raw' | 'hour' | 'day' | 'week' | 'month' | 'year'. Buckets start in time zone p_tz;
-- date_trunc('week') starts on Monday, which is the ISO week start.
create or replace function public.ras_tags_series(
  p_system uuid, p_tags text[], p_bucket text, p_since timestamptz,
  p_until timestamptz default now(), p_tz text default 'UTC')
returns table (tag text, bucket_start timestamptz, avg_v double precision, min_v double precision, max_v double precision, n bigint)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  if p_bucket not in ('raw','hour','day','week','month','year') then raise exception 'bad bucket: %', p_bucket; end if;
  if p_bucket = 'raw' then
    return query
      select t.tag, r.read_at, r.value::double precision, r.value::double precision, r.value::double precision, 1::bigint
      from public.ras_tag_readings r join public.ras_plc_tags t on t.id = r.tag_id
      where t.system_id = p_system and t.tag = any(p_tags) and r.value is not null
        and r.read_at >= p_since and r.read_at < p_until
      order by t.tag, r.read_at limit 20000;
  else
    return query
      with src as (
        select r.tag_id, r.read_at as ts, r.value as s, r.value as mn, r.value as mx, 1::bigint as c
        from public.ras_tag_readings r
        where r.value is not null and r.read_at >= p_since and r.read_at < p_until
          and r.tag_id in (select id from public.ras_plc_tags where system_id = p_system and tag = any(p_tags))
        union all
        select h.tag_id, h.hour, h.sum_v, h.min_v, h.max_v, h.n
        from public.ras_tag_hourly h
        where h.hour >= p_since and h.hour < p_until
          and h.tag_id in (select id from public.ras_plc_tags where system_id = p_system and tag = any(p_tags))
      )
      select t.tag, (date_trunc(p_bucket, s.ts at time zone p_tz) at time zone p_tz),
             (sum(s.s) / sum(s.c))::double precision, min(s.mn)::double precision, max(s.mx)::double precision, sum(s.c)::bigint
      from src s join public.ras_plc_tags t on t.id = s.tag_id
      group by t.tag, 2 order by t.tag, 2;
  end if;
end $$;
revoke execute on function public.ras_tags_series(uuid, text[], text, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.ras_tags_series(uuid, text[], text, timestamptz, timestamptz, text) to authenticated;

-- Extra tags: valve position and water-quality analysers on spare %IW channels, and four values per jar
-- (flow, oxygen out, pressure, temperature) on the RS-485 jar bus, 80 registers per line, 4 per jar.
-- Alarm limits are the farm standards and the dashboard starting guides.
create or replace function public.ras_seed_extra_tags(p_system uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare ai int; li int := 0; ln record; j record; n text; base int; nl int;
begin
  select count(*) into nl from public.ras_lines l join public.ras_stations st on st.id = l.station_id where st.system_id = p_system;
  ai := 4 + 5 * nl;
  for ln in select l.id lid, st.id sid, st.number num, l.label lab from public.ras_lines l
            join public.ras_stations st on st.id = l.station_id where st.system_id = p_system order by st.number, l.label loop
    insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, range_lo, range_hi, station_id, line_id, quantity)
    values (p_system, 'ZT-'||ln.num||ln.lab, 'Station '||ln.num||' line '||ln.lab||' mean valve position', 'AI', '%IW'||ai, '%', 0, 100, ln.sid, ln.lid, 'other')
    on conflict (system_id, tag) do nothing;
    ai := ai + 1;
  end loop;
  insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, range_lo, range_hi, alarm_lo, alarm_hi, quantity) values
    (p_system,'AT-NH3','Ammonia','AI','%IW'||ai,'mg/L',0,10,null,0.25,'other'),
    (p_system,'AT-NO2','Nitrite','AI','%IW'||(ai+1),'mg/L',0,5,null,0,'other'),
    (p_system,'AT-NO3','Nitrate','AI','%IW'||(ai+2),'mg/L',0,200,null,0,'other'),
    (p_system,'AT-PH','pH','AI','%IW'||(ai+3),'',0,14,6.8,8.2,'other'),
    (p_system,'AT-ALK','Alkalinity','AI','%IW'||(ai+4),'mg/L',0,300,null,100,'other'),
    (p_system,'AT-TURB','Turbidity','AI','%IW'||(ai+5),'NTU',0,100,null,15,'other'),
    (p_system,'AT-CAH','Calcium hardness','AI','%IW'||(ai+6),'mg/L',0,500,null,200,'other'),
    (p_system,'AT-HARD','Total water hardness','AI','%IW'||(ai+7),'mg/L CaCO3',0,500,null,null,'other')
  on conflict (system_id, tag) do nothing;
  for ln in select l.id lid, st.id sid, st.number num, l.label lab from public.ras_lines l
            join public.ras_stations st on st.id = l.station_id where st.system_id = p_system order by st.number, l.label loop
    for j in select position from public.ras_jars where line_id = ln.lid order by position loop
      n := ln.num || ln.lab || '-' || lpad(j.position::text, 2, '0');
      base := 100 + li * 80 + (j.position - 1) * 4;
      insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, range_lo, range_hi, alarm_lo, alarm_hi, station_id, line_id, quantity) values
        (p_system,'JF-'||n,'Jar '||n||' flow','AI','%MW'||base,'L/min',0,10,3.42,5.14,ln.sid,ln.lid,'flow'),
        (p_system,'JO-'||n,'Jar '||n||' oxygen out','AI','%MW'||(base+1),'mg/L',0,20,5,null,ln.sid,ln.lid,'do_out'),
        (p_system,'JP-'||n,'Jar '||n||' water pressure','AI','%MW'||(base+2),'bar',0,2.5,0.08,0.6,ln.sid,ln.lid,'pressure'),
        (p_system,'JT-'||n,'Jar '||n||' temperature','AI','%MW'||(base+3),'C',0,50,26,31,ln.sid,ln.lid,'temperature')
      on conflict (system_id, tag) do nothing;
    end loop;
    li := li + 1;
  end loop;
end $$;
revoke execute on function public.ras_seed_extra_tags(uuid) from public, anon;
grant  execute on function public.ras_seed_extra_tags(uuid) to authenticated;

-- New systems get the extra tags too.
create or replace function public.ras_create_system(p_name text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare sid uuid;
begin
  insert into public.ras_systems (name) values (p_name) returning id into sid;
  insert into public.ras_settings (system_id) values (sid);
  insert into public.ras_pumps (system_id, tag, role) values (sid,'P-1','duty'), (sid,'P-2','standby');
  insert into public.ras_control_loops (system_id, code, name, process_variable, setpoint, high_limit, kp, ti_s, out_min, out_max) values
    (sid,'F','Pump speed','flow',0.2,0.6,60,15,0,110),
    (sid,'D','Aeration valve',null,6.5,null,40,120,0,100),
    (sid,'T','Heater and chiller',null,29,null,50,180,-100,100);
  perform public.ras_seed_layout(sid);
  perform public.ras_seed_tags(sid);
  perform public.ras_seed_extra_tags(sid);
  return sid;
end $$;

-- Existing systems
select public.ras_seed_extra_tags(id) from public.ras_systems;
