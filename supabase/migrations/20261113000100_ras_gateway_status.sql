-- One row per system: written by the PLC gateway (service role) every 15 s, read by the app to show whether
-- live data is arriving. Works over any connection the plant computer has (Wi-Fi, Ethernet, mobile data).
create table public.ras_gateway_status (
  system_id     uuid primary key references public.ras_systems(id) on delete cascade,
  last_seen     timestamptz not null default now(),
  mode          text not null default 'plc' check (mode in ('plc','simulate')),
  plc_connected boolean not null default false,
  tags_ok       int not null default 0,
  tags_bad      int not null default 0,
  message       text,
  version       text,
  host          text
);
alter table public.ras_gateway_status enable row level security;
create policy ras_gateway_status_read on public.ras_gateway_status for select to authenticated using (true);
