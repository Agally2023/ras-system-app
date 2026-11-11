-- =====================================================================
-- RAS System: Supabase / Postgres schema
-- Derived from McDonald_jar_flow_dashboard.html
-- Tables are prefixed ras_ and live in public so the Supabase API
-- exposes them without extra settings. RLS is enabled on every table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Users and roles (Admin / Data entry / viewer)
-- ---------------------------------------------------------------------
create table public.ras_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text not null default 'viewer' check (role in ('viewer','operator','admin')),
  created_at  timestamptz not null default now()
);

create or replace function public.ras_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ras_profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end $$;

create trigger ras_on_auth_user_created
  after insert on auth.users
  for each row execute function public.ras_handle_new_user();

create or replace function public.ras_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.ras_profiles where id = (select auth.uid())
$$;
revoke execute on function public.ras_role() from public, anon;
grant  execute on function public.ras_role() to authenticated;

-- ---------------------------------------------------------------------
-- 1. System, settings (Admin tab) and layout (System map tab)
-- ---------------------------------------------------------------------
create table public.ras_systems (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  location          text,
  notes             text,
  -- PLC I/O tab controls
  pump_command      boolean not null default true,              -- PUMP_CMD
  pump_speed_pct    numeric not null default 100 check (pump_speed_pct between 0 and 110), -- VFD_SPD
  plc_data_source   text not null default 'sim' check (plc_data_source in ('sim','man','live')),
  created_at        timestamptz not null default now()
);

-- One row per system: every field of the Admin tab plus the dashboard targets
create table public.ras_settings (
  system_id          uuid primary key references public.ras_systems(id) on delete cascade,
  -- pump and valves
  pump_shutoff_head_m        numeric not null default 3     check (pump_shutoff_head_m > 0),    -- H0
  pump_free_flow_lpm         numeric not null default 60    check (pump_free_flow_lpm > 0),     -- Qm
  valve_capacity_lpm_per_rm  numeric not null default 12    check (valve_capacity_lpm_per_rm > 0), -- G
  line_head_m                numeric not null default 2,                                        -- Hl
  pump_margin_pct            numeric not null default 15,                                       -- pm
  -- oxygen and sump
  do_min_mgl                 numeric not null default 5,                                        -- DOmin
  do_supply_mgl              numeric not null default 7,                                        -- DOsup
  o2_use_mg_per_kg_h         numeric not null default 100,                                      -- O2use
  sump_volume_m3             numeric not null default 8,                                        -- Vs
  aeration_kla_per_min       numeric not null default 0.5,                                      -- KLA
  background_do_demand       numeric not null default 0.03,                                     -- bgd, mg/L per min
  ambient_temp_c             numeric not null default 24,                                       -- Tamb
  heater_power_c_per_min     numeric not null default 0.1,                                      -- Gh
  site_altitude_m            numeric not null default 0,                                        -- alt
  water_temp_c               numeric not null default 29,                                       -- T
  -- layout
  stations                   int     not null default 3 check (stations > 0),                   -- ns
  lines_per_station          int     not null default 2 check (lines_per_station > 0),          -- nl
  jars_per_line              int     not null default 18 check (jars_per_line > 0),             -- nj
  stage34_share_pct          numeric not null default 50 check (stage34_share_pct between 0 and 100), -- p34
  stage34_flow_boost_pct     numeric not null default 10 check (stage34_flow_boost_pct between 0 and 10), -- boost
  header_diameter_mm         numeric not null default 50,                                       -- hd
  jar_spacing_m              numeric not null default 0.25,                                     -- sp
  -- eggs
  max_egg_mass_g             numeric not null default 1200,                                     -- Mmax
  egg_diameter_mm            numeric not null default 2,                                        -- de
  egg_density_kg_m3          numeric not null default 1050,                                     -- rs
  -- dashboard targets
  target_bed_expansion       numeric not null default 1.3 check (target_bed_expansion between 1.1 and 1.8), -- R
  bucket_volume_l            numeric not null default 10,                                       -- bv
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references auth.users(id)
);

create table public.ras_stations (
  id         uuid primary key default gen_random_uuid(),
  system_id  uuid not null references public.ras_systems(id) on delete cascade,
  number     int  not null check (number > 0),
  name       text,
  unique (system_id, number)
);

create table public.ras_lines (
  id          uuid primary key default gen_random_uuid(),
  station_id  uuid not null references public.ras_stations(id) on delete cascade,
  label       text not null,                       -- 'A', 'B', ...
  unique (station_id, label)
);

-- One row per jar: current valve setting and stage (System map tab)
create table public.ras_jars (
  id              uuid primary key default gen_random_uuid(),
  line_id         uuid not null references public.ras_lines(id) on delete cascade,
  position        int  not null check (position > 0),    -- 1 = first jar on the header
  stage           int  not null default 1 check (stage between 1 and 4),
  valve_open_pct  numeric not null default 40 check (valve_open_pct between 0 and 100),
  is_on           boolean not null default true,
  notes           text,
  updated_at      timestamptz not null default now(),
  unique (line_id, position)
);

-- ---------------------------------------------------------------------
-- 2. Data entry tab: measurement sheet and bucket tests
-- ---------------------------------------------------------------------
create table public.ras_jar_measurements (
  id                   uuid primary key default gen_random_uuid(),
  jar_id               uuid not null references public.ras_jars(id) on delete cascade,
  measured_at          timestamptz not null default now(),
  jar_diameter_cm      numeric check (jar_diameter_cm > 0),   -- D, mid-bed
  drop_pipe_id_mm      numeric check (drop_pipe_id_mm > 0),   -- dp
  jar_volume_l         numeric check (jar_volume_l > 0),      -- Vj
  spout_depth_cm       numeric check (spout_depth_cm > 0),    -- Hs
  egg_mass_g           numeric check (egg_mass_g >= 0),       -- m
  egg_stage            int check (egg_stage between 1 and 4), -- st
  settled_height_cm    numeric check (settled_height_cm > 0), -- h0
  bed_height_flow_cm   numeric,                               -- h (optional)
  do_inlet_mgl         numeric,                               -- DOi (optional)
  do_overflow_mgl      numeric,                               -- DOo (optional)
  measured_by          uuid references auth.users(id),
  notes                text
);

create table public.ras_bucket_tests (
  id               uuid primary key default gen_random_uuid(),
  jar_id           uuid not null references public.ras_jars(id) on delete cascade,
  tested_at        timestamptz not null default now(),
  time_s           numeric not null check (time_s > 0),
  volume_l         numeric not null check (volume_l >= 0),
  flow_lpm         numeric generated always as (60 * volume_l / time_s) stored,  -- Qmeas
  model_flow_lpm   numeric,
  valve_open_pct   numeric check (valve_open_pct between 0 and 100),
  tested_by        uuid references auth.users(id),
  notes            text
);

-- ---------------------------------------------------------------------
-- 3. Calculated results per jar, saved on demand (Dashboard / Results)
-- ---------------------------------------------------------------------
create table public.ras_jar_states (
  id                 bigint generated always as identity primary key,
  jar_id             uuid not null references public.ras_jars(id) on delete cascade,
  recorded_at        timestamptz not null default now(),
  flow_lpm           numeric,
  rise_speed_cm_s    numeric,
  drop_pipe_speed_cm_s numeric,
  bed_expansion      numeric,
  jet_reynolds       numeric,
  head_m             numeric,
  required_flow_lpm  numeric,
  status             text check (status in
    ('Washout','Load too big','Bed still','Too gentle','Slightly low','In target','Vigorous','Too strong','Off'))
);

-- ---------------------------------------------------------------------
-- 4. RAS control tab: pumps, loops, event log
-- ---------------------------------------------------------------------
create table public.ras_pumps (
  id          uuid primary key default gen_random_uuid(),
  system_id   uuid not null references public.ras_systems(id) on delete cascade,
  tag         text not null,                                   -- P-1, P-2
  role        text not null check (role in ('duty','standby')),
  state       text not null default 'stopped' check (state in ('running','stopped','tripped')),
  unique (system_id, tag)
);

create table public.ras_control_loops (
  id              uuid primary key default gen_random_uuid(),
  system_id       uuid not null references public.ras_systems(id) on delete cascade,
  code            text not null check (code in ('F','D','T')),   -- pump speed, aeration, heater/chiller
  name            text not null,
  mode            text not null default 'auto' check (mode in ('auto','manual')),
  process_variable text,                                         -- F loop: 'flow' or 'pressure'
  setpoint        numeric,                                       -- D mg/L, T C, F pressure bar
  high_limit      numeric,                                       -- F loop high pressure limit, bar
  kp              numeric,
  ti_s            numeric,
  manual_output   numeric not null default 0,
  out_min         numeric not null,
  out_max         numeric not null,
  flow_boost_enabled boolean not null default true,              -- D loop: raise flow up to 10% on low DO
  unique (system_id, code)
);

create table public.ras_control_events (
  id          bigint generated always as identity primary key,
  system_id   uuid not null references public.ras_systems(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  message     text not null,
  actor       uuid references auth.users(id)
);

-- ---------------------------------------------------------------------
-- 5. PLC I/O tab: tags, readings, alarms
-- ---------------------------------------------------------------------
create table public.ras_plc_tags (
  id            uuid primary key default gen_random_uuid(),
  system_id     uuid not null references public.ras_systems(id) on delete cascade,
  tag           text not null,                                   -- PT-100, FT-1A, AT-1Ai, PUMP_RUN ...
  description   text,
  io_type       text not null check (io_type in ('AI','AO','DI','DO')),
  plc_address   text,                                            -- %IW0, %I0.0 ...
  unit          text,
  range_lo      numeric,                                         -- 4 mA value, AI only
  range_hi      numeric,                                         -- 20 mA value, AI only
  alarm_lo      numeric,
  alarm_hi      numeric,
  station_id    uuid references public.ras_stations(id) on delete set null,
  line_id       uuid references public.ras_lines(id) on delete set null,
  quantity      text check (quantity in ('pressure','flow','temperature','do_in','do_out','do_sump','other')),
  unique (system_id, tag)
);

create table public.ras_tag_readings (
  id          bigint generated always as identity primary key,
  tag_id      uuid not null references public.ras_plc_tags(id) on delete cascade,
  read_at     timestamptz not null default now(),
  value       numeric,                                           -- null = no signal
  milliamps   numeric,
  state       text not null default 'ok' check (state in ('ok','low','high','bad'))  -- bad = sensor fault (<3.8 or >20.5 mA)
);

create table public.ras_alarms (
  id              uuid primary key default gen_random_uuid(),
  tag_id          uuid not null references public.ras_plc_tags(id) on delete cascade,
  state           text not null check (state in ('low','high','bad')),
  value           numeric,
  raised_at       timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  cleared_at      timestamptz
);

-- ---------------------------------------------------------------------
-- 6. Admin tab: published reference values
-- ---------------------------------------------------------------------
create table public.ras_reference_values (
  id              uuid primary key default gen_random_uuid(),
  item            text not null,
  published_value text not null,
  source          text
);

insert into public.ras_reference_values (item, published_value, source) values
 ('Standard jar size', 'About 15.9 cm diameter, 45.8 cm high, 6.86 L, feeder tube about 3 cm', 'Vendor data sheet'),
 ('Jar used in research', '16 cm diameter, 45 cm high, 6 L', 'USGS striped bass study'),
 ('Catfish eggs', '2 to 3 L/min, enough to gently stir or fluidise the eggs', 'Texas A&M extension guide'),
 ('McDonald incubator, 6.8 L', 'About 4 L/min', 'Aquacultur MC-I data sheet'),
 ('McDonald-type jar', 'About 1 gpm (3.8 L/min), depending on the weight of the eggs', 'PentairAES product page'),
 ('Tilapia incubation', '4 to 6 L/min per jar, and a best result at 7.66 L/min in a commercial study', 'Tilapia hatching patent and Aquaculture 2018 study');

-- ---------------------------------------------------------------------
-- 7. Indexes on foreign keys and time series
-- ---------------------------------------------------------------------
create index on public.ras_stations (system_id);
create index on public.ras_lines (station_id);
create index on public.ras_jars (line_id);
create index on public.ras_jar_measurements (jar_id, measured_at desc);
create index on public.ras_bucket_tests (jar_id, tested_at desc);
create index on public.ras_jar_states (jar_id, recorded_at desc);
create index on public.ras_pumps (system_id);
create index on public.ras_control_events (system_id, occurred_at desc);
create index on public.ras_plc_tags (system_id);
create index on public.ras_plc_tags (station_id);
create index on public.ras_plc_tags (line_id);
create index on public.ras_tag_readings (tag_id, read_at desc);
create index on public.ras_alarms (tag_id, raised_at desc);
create index on public.ras_alarms (tag_id) where cleared_at is null;
create index on public.ras_jar_measurements (measured_by);
create index on public.ras_bucket_tests (tested_by);
create index on public.ras_alarms (acknowledged_by);
create index on public.ras_control_events (actor);
create index on public.ras_settings (updated_by);

-- ---------------------------------------------------------------------
-- 8. Views
-- ---------------------------------------------------------------------
create view public.ras_jar_overview with (security_invoker = true) as
select j.id as jar_id,
       st.system_id,
       'S' || st.number || '-' || l.label || '-' || j.position as jar_code,
       st.number as station, l.label as line, j.position,
       j.stage, j.valve_open_pct, j.is_on,
       m.jar_diameter_cm, m.drop_pipe_id_mm, m.jar_volume_l, m.spout_depth_cm,
       m.egg_mass_g, m.settled_height_cm, m.measured_at
from public.ras_jars j
join public.ras_lines l     on l.id = j.line_id
join public.ras_stations st on st.id = l.station_id
left join lateral (
  select * from public.ras_jar_measurements mm
  where mm.jar_id = j.id order by mm.measured_at desc limit 1
) m on true;

create view public.ras_active_alarms with (security_invoker = true) as
select a.*, t.tag, t.description, t.unit, t.system_id
from public.ras_alarms a
join public.ras_plc_tags t on t.id = a.tag_id
where a.cleared_at is null;

-- ---------------------------------------------------------------------
-- 9. Row Level Security
--    viewer   : read everything
--    operator : data entry, valves, stages, alarm acks, control actions
--    admin    : everything, including settings, layout and PLC tags
--    The PLC gateway writes readings with the service role key (bypasses RLS).
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'ras_profiles','ras_systems','ras_settings','ras_stations','ras_lines','ras_jars',
    'ras_jar_measurements','ras_bucket_tests','ras_jar_states','ras_pumps',
    'ras_control_loops','ras_control_events','ras_plc_tags','ras_tag_readings',
    'ras_alarms','ras_reference_values']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t||'_read', t);
  end loop;

  -- admin-only structure and configuration
  foreach t in array array['ras_systems','ras_settings','ras_stations','ras_lines','ras_plc_tags','ras_reference_values']
  loop
    execute format($f$create policy %I on public.%I for all to authenticated
      using ((select public.ras_role()) = 'admin') with check ((select public.ras_role()) = 'admin')$f$, t||'_admin', t);
  end loop;

  -- operator or admin: day to day data
  foreach t in array array['ras_jars','ras_jar_measurements','ras_bucket_tests','ras_jar_states',
                           'ras_pumps','ras_control_loops','ras_control_events','ras_tag_readings','ras_alarms']
  loop
    execute format($f$create policy %I on public.%I for all to authenticated
      using ((select public.ras_role()) in ('operator','admin'))
      with check ((select public.ras_role()) in ('operator','admin'))$f$, t||'_ops', t);
  end loop;
end $$;

-- only admins can change roles (all signed-in users can read profiles)
create policy ras_profiles_admin on public.ras_profiles for all to authenticated
  using ((select public.ras_role()) = 'admin') with check ((select public.ras_role()) = 'admin');

-- ---------------------------------------------------------------------
-- 10. Helpers that mirror the dashboard: create a system, build the layout, build the PLC tag list
-- ---------------------------------------------------------------------
create or replace function public.ras_seed_layout(p_system uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare s public.ras_settings; a int; stn uuid; ln uuid; i int; l int; k int; st int;
begin
  select * into s from public.ras_settings where system_id = p_system;
  a := round(s.jars_per_line * (1 - s.stage34_share_pct / 100.0));
  for i in 1..s.stations loop
    insert into public.ras_stations (system_id, number, name) values (p_system, i, 'Station ' || i)
      on conflict (system_id, number) do update set name = excluded.name returning id into stn;
    for l in 1..s.lines_per_station loop
      insert into public.ras_lines (station_id, label) values (stn, chr(64 + l))
        on conflict (station_id, label) do update set label = excluded.label returning id into ln;
      for k in 0..s.jars_per_line - 1 loop
        st := case when k < a / 2.0 then 1
                   when k < a then 2
                   when k < a + (s.jars_per_line - a) / 2.0 then 3
                   else 4 end;
        insert into public.ras_jars (line_id, position, stage) values (ln, k + 1, st)
          on conflict (line_id, position) do nothing;
      end loop;
    end loop;
  end loop;
end $$;

create or replace function public.ras_seed_tags(p_system uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare s public.ras_settings; ai int := 0; rt numeric; q numeric := 70;
        stn record; ln record; n text;
begin
  select * into s from public.ras_settings where system_id = p_system;
  rt := s.stations * s.lines_per_station * q;

  insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, range_lo, range_hi, alarm_lo, alarm_hi, quantity) values
   (p_system,'PT-100','Pump discharge pressure','AI','%IW'||ai,'bar',0,4,0.15,1,'pressure'),
   (p_system,'FT-100','Total supply flow','AI','%IW'||(ai+1),'L/min',0,1000,round(0.8*rt),round(1.2*rt),'flow'),
   (p_system,'TT-100','Sump water temperature','AI','%IW'||(ai+2),'C',0,50,26,31,'temperature'),
   (p_system,'AT-100','Sump dissolved oxygen','AI','%IW'||(ai+3),'mg/L',0,20,s.do_min_mgl,12,'do_sump');
  ai := 4;

  for stn in select id, number from public.ras_stations where system_id = p_system order by number loop
    for ln in select id, label from public.ras_lines where station_id = stn.id order by label loop
      n := stn.number || ln.label;
      insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, range_lo, range_hi, alarm_lo, alarm_hi, station_id, line_id, quantity) values
       (p_system,'PT-'||n,'Station '||stn.number||' line '||ln.label||' header pressure','AI','%IW'||ai,'bar',0,2.5,0.1,0.6,stn.id,ln.id,'pressure'),
       (p_system,'FT-'||n,'Station '||stn.number||' line '||ln.label||' flow','AI','%IW'||(ai+1),'L/min',0,300,round(0.8*q),round(1.2*q),stn.id,ln.id,'flow'),
       (p_system,'TT-'||n,'Station '||stn.number||' line '||ln.label||' temperature','AI','%IW'||(ai+2),'C',0,50,26,31,stn.id,ln.id,'temperature'),
       (p_system,'AT-'||n||'i','Station '||stn.number||' line '||ln.label||' inlet dissolved oxygen','AI','%IW'||(ai+3),'mg/L',0,20,6,12,stn.id,ln.id,'do_in'),
       (p_system,'AT-'||n||'o','Station '||stn.number||' line '||ln.label||' overflow dissolved oxygen','AI','%IW'||(ai+4),'mg/L',0,20,s.do_min_mgl,12,stn.id,ln.id,'do_out');
      ai := ai + 5;
    end loop;
  end loop;

  insert into public.ras_plc_tags (system_id, tag, description, io_type, plc_address, unit, quantity) values
   (p_system,'PUMP_RUN','Pump running feedback','DI','%I0.0',null,'other'),
   (p_system,'PUMP_FAULT','Pump fault','DI','%I0.1',null,'other'),
   (p_system,'SUMP_LOW','Sump low level','DI','%I0.2',null,'other'),
   (p_system,'PUMP_CMD','Pump start command','DO','%Q0.0',null,'other'),
   (p_system,'HORN','Alarm horn','DO','%Q0.1',null,'other'),
   (p_system,'VFD_SPD','Pump drive speed','AO','%QW0','%','other');
end $$;

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
  return sid;
end $$;

revoke execute on function public.ras_seed_layout(uuid), public.ras_seed_tags(uuid), public.ras_create_system(text) from public, anon;
grant  execute on function public.ras_seed_layout(uuid), public.ras_seed_tags(uuid), public.ras_create_system(text) to authenticated;

-- Usage, after you sign up and promote yourself:
--   update public.ras_profiles set role = 'admin' where id = '<your auth user id>';
--   select public.ras_create_system('Main RAS');
