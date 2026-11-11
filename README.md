# RAS System

Web app for managing a recirculating aquaculture system (RAS) of McDonald egg-incubation jars.
Built from the McDonald jar flow dashboard: fluidised-bed flow model, valve settings, bucket tests,
measurement sheet, PLC tag list and alarms, backed by Supabase.

Stack: Vite, React, TypeScript, Supabase (Postgres, Auth, Row Level Security).

## What is in the box

| Tab | What it does |
| --- | --- |
| Dashboard | Per-line jar table. Valve sliders save to the database, and Auto-set valves finds the openings that give each jar its target flow. Flow, expansion and status come from the model in `src/lib/model.ts` |
| Jar simulator | Animated plumbing schematic of 4 jars on one pump and header. Drag a valve slider or type a flow in L/min per jar and watch the egg bed lift, wash out or splash. Live 10 L buckets, auto-tune, surge test. What-if only, nothing is saved |
| Data entry | Bucket tests (flow = 60 x volume / time) and the jar measurement sheet |
| PLC I/O | I/O list and active alarms with acknowledge |
| Admin | All pump, valve, oxygen, layout and egg settings. Creates the system on first use |

Roles: `viewer` (read), `operator` (data entry, valves, alarm acks), `admin` (everything).

## 1. Supabase

1. Supabase project "RAS System" (ref isfqytwwdncagbofuqxg, eu-central-1) already exists with the schema applied. For a fresh project, create one first.
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

## PLC gateway (not included)

A browser cannot talk to a PLC. A small gateway (Node-RED, an edge function, or a script on the
plant network) should insert rows into `ras_tag_readings` and `ras_alarms` using the service-role
key. Never put the service-role key in this front-end.

## Not yet ported from the dashboard

RAS control simulation (pumps, pipes and PID control) and the manual with all symbols.
Auto-set valves (per line, on the Dashboard) is included.
