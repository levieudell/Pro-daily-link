# Pro Daily Link

A responsive, interactive MVP for construction field operations. It connects customers, projects, job sites, estimates, crew assignments, and AI-assisted daily reporting.

## Run locally

Start the included Node server (Node 20 or newer):

```powershell
npm start
```

Then open `http://localhost:4173`. Data is stored in `data/db.json`.

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

The repository includes `render.yaml` for a Render web service. Production secrets are entered in Render's environment settings and must never be committed. Set `PDL_SUPABASE_ENABLED=1` to use Supabase private storage and health checks. Supabase stores tenant data and private uploads; Render runs the Node web application.

This is a connected MVP. Public production launch still requires completing the PostgreSQL repository cutover, backup/restore validation, billing, and monitoring.
