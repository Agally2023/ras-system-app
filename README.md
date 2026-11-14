# RAS System

Web app for managing a recirculating aquaculture system (RAS) of McDonald egg-incubation jars.
Built from the McDonald jar flow dashboard: fluidised-bed flow model, valve settings, bucket tests,
measurement sheet, PLC tag list and alarms, backed by Supabase.

Stack: Vite, React, TypeScript, Supabase (Postgres, Auth, Row Level Security).

## What is in the box

| Tab | What it does |
| --- | --- |
| Dashboard | Live graphs for every attribute on the HMI (water quality, pump, line and jar KPIs) at live, hourly, daily, weekly (ISO weeks), monthly and yearly resolution, with the farm standards drawn on each graph. Shows PLC data from `ras_tags_series()` once the gateway has written readings, and a simulation (`src/lib/series.ts`) before that |
| Jar simulator | Animated plumbing schematic of 4 jars on one pump and header. Drag a valve slider or type a flow in L/min per jar and watch the egg bed lift, wash out or splash. Live 10 L buckets, auto-tune, surge test. What-if only, nothing is saved |
| Data entry | Bucket tests (flow = 60 x volume / time) and the jar measurement sheet |
| PLC I/O | I/O list and active alarms with acknowledge |
| Admin | All pump, valve, oxygen, layout and egg settings. Creates the system on first use |

Roles: `viewer` (read), `operator` (data entry, valves, alarm acks), `admin` (everything).

## 1. Supabase

1. Supabase project (ref rciyzoosuncncecqmqaq, eu-north-1) already exists with the schema applied. For a fresh project, create one first.
2. For a fresh project, apply the two files in `supabase/migrations/` in order (SQL editor, or `supabase db push`).
3. Authentication > Providers: keep Email enabled.
4. Sign up in the app once, then promote yourself in the SQL editor:
   `update public.ras_profiles set role = 'admin' where id = '<your auth user id>';`
5. The "Main RAS" system (3 stations, 6 lines, 108 jars, 40 PLC tags) is already created in the RAS System project. For a fresh project, use the Admin tab to create it.

## 2. Run locally

```bash
npm install
cp .env.example .env.local   # fill in the URL and publishable key
npm run dev
```

## 3. GitHub and deployment (GitHub Pages)

```bash
git init && git add . && git commit -m "RAS System: initial project"
git branch -M main
git remote add origin https://github.com/Agally2023/ras-system-app.git
git push -u origin main
```

1. On GitHub: repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Every push to `main` runs `.github/workflows/deploy.yml`, which builds the app and publishes it.
   The site appears at `https://agally2023.github.io/ras-system-app/` (adjust if the repo is in an organization).
3. In Supabase: **Authentication > URL Configuration**, set Site URL to that address and add it to Redirect URLs.
4. The workflow already contains the Supabase URL and publishable key. To change them, add repository
   variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Settings > Secrets and variables > Actions > Variables.

The app uses hash routes (`/#/data`), which is what lets it work on GitHub Pages without server rewrites.
Private repos need a GitHub plan that includes Pages for private repositories.

## PLC gateway

A browser cannot talk to a PLC, so `gateway/` holds a small Node script for the plant computer. It reads the PLC over
Modbus TCP and writes `ras_tag_readings` and `ras_alarms` with the Supabase service-role key (keep that key on the plant
computer; never put it in this front-end).

```
cd gateway && npm install && cp .env.example .env     # fill in SUPABASE_SERVICE_ROLE_KEY and PLC_HOST
node gateway.mjs --simulate                           # tests the whole path with no PLC
node gateway.mjs                                      # reads the PLC
```

- Tags come from `ras_plc_tags`: 486 for the default layout. 40 are the pump, line and valve tags, 8 are the water-quality
  analysers, and 432 are the jar sensors (flow, oxygen out, pressure, temperature for each of the 108 jars) read from RS-485
  bus registers `%MW100` onward: 80 registers per line, 4 per jar, each holding value x 100 as a signed 16-bit integer.
- `%IW` analog inputs are scaled from 4-20 mA with `AI_RAW_4MA` / `AI_RAW_20MA`. Below 3.8 mA or above 20.5 mA is a sensor
  fault (state `bad`). Check these against your analog card and the Modbus map of your PLC.
- Plant tags are polled every 10 s and jar tags every 60 s. Once an hour the gateway calls `ras_rollup_readings()`, which
  summarises completed hours into `ras_tag_hourly` and deletes the raw rows, so history stays small.
- The Dashboard reads `ras_tags_series()`, which groups readings by hour, day, ISO week (Monday start), month and year in
  the browser's time zone. It shows live PLC data as soon as any reading exists, and a simulation before that.
- Migration: `supabase/migrations/20261113000000_ras_readings_series.sql`.

## Remote access over Wi-Fi

The app is a normal website (GitHub Pages) backed by Supabase, so the dashboard and PLC readings can be read from any phone,
tablet or computer with internet and a login. Nothing on the plant network is opened to the outside:

```
PLC --(Ethernet or plant Wi-Fi, Modbus TCP)--> plant computer running gateway/ --(outbound HTTPS)--> Supabase --> your phone
```

- Put the plant computer on the plant Wi-Fi (or Ethernet) with internet. The gateway only makes outbound connections.
- The header shows a gateway badge: green when readings arrived in the last 45 s, amber when slow, red when offline. If Wi-Fi
  drops, the gateway reconnects by itself and carries on (readings missed while it was offline are not back-filled).
- On a phone, open the site and choose Add to Home Screen to install it. The HMI page switches to a full-width phone layout.
- Alarm sound plays while an alarm is active (Alarm sound button; browsers need one tap to allow sound). A phone that is
  locked or has the page in the background will not play it; use a plant-side horn wired to the PLC for unattended alarms.

## Not yet ported from the dashboard

RAS control simulation (pumps, pipes and PID control) and the manual with all symbols.
Auto-set valves is on the Jar simulator page.

## SCADA and DCS views

- **SCADA** (`#/scada`): plant-wide supervision. Live mimic of the sump, pumps, three stations with all 108 jars, drum filter, biofilter and water-quality analysers; alarm summary with acknowledge and a journal; trends for any tag; tag browser. Uses PLC readings once the gateway writes them, otherwise a simulation.
- **DCS** (`#/dcs`): control view with PID faceplates for the pump-speed, aeration and temperature loops (settings from `ras_control_loops`), AUTO/MAN, setpoint entry (Save writes the loop and logs to `ras_control_events`), interlocks and deviation alarms with siren. The process behind the loops is simulated until a PLC runs them.

## PLC plan

The **PLC plan** tab (`#/plan`) shows where the automation equipment sits (site plan), how it is laid out inside the control panel, and how signals are wired (4-20 mA, PNP/NPN inputs, direct-on-line pump starter). It is a planning drawing; have an electrician confirm ratings and cable sizes.

## Installable package

Every push to `main` builds `RAS-Hatchery-Setup.zip` and attaches it to the GitHub release named `latest` (Releases page). Unzip it on the monitor computer and run `Install-Windows.bat`; see `installer/README-INSTALL.txt`.

## Android app

CI builds a signed `RAS-Hatchery.apk` (Capacitor wrapper around the same app) into the `latest` release. On the phone: download it, allow "install unknown apps" for the browser or Files app, open the APK. The signing key lives in the GitHub Actions cache; if it is ever lost, uninstall the old app before installing a new build.
