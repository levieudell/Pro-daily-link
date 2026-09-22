# Pro Daily Link

A responsive, interactive MVP for construction field operations. It connects customers, projects, job sites, estimates, crew assignments, and AI-assisted daily reporting.

## Run locally

Start the included Node server (Node 20 or newer):

```powershell
npm start
```

Then open `http://localhost:4173`. Data is stored in `data/db.json`.

The committed `data/db.json` file is the Northstar Construction sales-demo workspace: a Portland general contractor with Oregon residential and light commercial jobs. New trial signups stay empty so a real company does not inherit sample jobs. Phone numbers use the reserved 555-0100–0199 exchange, and email addresses use the reserved `.example` domain, so the demo does not publish a live number or inbox.

## Refresh the demo workspace

The server reads `data/db.json` into memory when the process starts, before it loads a Supabase company snapshot. On the Render demo (`PDL_SUPABASE_ENABLED=1`), that cloud snapshot replaces the file on disk and is what the app shows.

After this repo is deployed, open the platform console and choose **Reset demo data** on the Northstar company. Reset keeps the live demo logins, sessions, and company name, restores projects, customers, crews, reports, and the schedule from the seed captured at startup, and writes that clean workspace back to Supabase. Restart the service after the deploy so the in-memory seed is the copy from this commit, then run the reset. Do not edit the live disk file by hand and expect Reset to restore it: reset uses the seed loaded at process start.

To enable genuine AI report extraction, copy `.env.example` to `.env`, provide an API key, and load those environment variables before starting the server. The key is only read by the backend and is never sent to the browser. Without a key, the application automatically uses its local construction-note extractor.

## Included workflows

- Operations overview and estimated-versus-actual production
- Customer and project tracking
- Crew and individual scheduling
- Team availability overview
- Daily field report creation
- Project photo libraries with office-reference and field-daily sources
- Multiple JPEG, PNG, or WebP photos per daily report
- AI-structured report preview and review queue
- Responsive desktop and mobile layouts

## API

- `GET /api/health` — service and AI status
- `GET /api/state` — company workspace
- `POST /api/ai/extract` — structured field-note conversion
- `POST /api/reports` — persist a daily report
- `POST /api/photos` — store office or field photos with project/report metadata
- `PATCH /api/reports/:id/approve` — approve a report
- `POST /api/projects`, `/api/team`, `/api/assignments` — create operating records

## Cloud demo

The repository includes `render.yaml` for a Render web service. Secrets are entered in Render's environment settings and must never be committed. Set `PDL_SUPABASE_ENABLED=1` to use Supabase private storage and health checks. The included Blueprint runs with authentication enforcement disabled for a controlled product demo; do not use that setting for a public customer launch.

This is a connected MVP. Public production launch still requires completing the PostgreSQL repository cutover, backup/restore validation, billing, and monitoring.
