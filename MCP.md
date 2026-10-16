# Pro Daily Link AI connector

A remote MCP connector for daily reports. An owner or office admin can read the company and save drafts. A project manager can read and draft dailies on assigned projects. A field user can clock in, tell the assistant what they did, and send that daily to the office. The connector never approves a daily.

The production connector URL is `https://app.prodailylink.com/mcp`. Office and field connections are already live. This change adds project manager access; until it is deployed, try that connection on a local app at `http://127.0.0.1:$PORT/mcp`.

## Connect Claude, ChatGPT, or Grok

Add a custom remote MCP server / connector and paste the connector URL. The assistant discovers OAuth by itself:

- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`
- Authorization server metadata: `/.well-known/oauth-authorization-server`
- Dynamic client registration: `POST /oauth/register`
- PKCE S256 is required. Public clients use `token_endpoint_auth_method: none`.
- Scopes: `daily:read` and `daily:write`. Omit the scope to request both.

Sign in with the same email and password you use in Pro Daily Link, then pick the company. An owner, office admin, project manager, or field user can connect. A project manager only sees the projects assigned to them in the app.

The demo tenant is `7176abe8-07e4-4336-a372-1163d2f21ff9`. DEMO Jordan Reed is a field user on the Concrete crew. A field connection only sees that person’s assignments, crew, and dailies.

## What the assistant can do

Office tools: `list_projects`, `get_estimate`, `list_dailies`, `get_daily`, `create_daily`, `update_daily`. New dailies are saved as Draft. Approved reports stay locked.

Project manager tools: `list_projects`, `get_estimate`, `list_dailies`, `get_daily`, `create_daily`, `update_daily`. Every tool is limited to the projects that manager can open in the app. `create_daily` always saves a Draft. `update_daily` changes a Draft or a Needs review report on those projects. Crew hours can be recorded only for people on the manager’s assigned crews. The connector does not approve or delete, even when that manager can approve in the app, and it does not include clock tools.

Field tools: `clock_in`, `clock_out`, `get_my_day`, `log_work`, `submit_daily`, plus the read tools limited to that person’s own work. `log_work` writes today’s draft. Pass estimate-line quantities when the line is known. Free text is mapped only onto an existing line; anything else stays in the notes. `submit_daily` is an explicit confirm after the assistant reads the summary back. It moves the draft to Needs review and does not approve it.

There is no delete tool and no approve tool.

## Try it locally with MCP Inspector

```bash
npm start
npx @modelcontextprotocol/inspector
```

Use the Streamable HTTP transport and the local `/mcp` URL. Inspector will open the sign-in and consent page.

## Production configuration

No new secret is required for public PKCE clients. Keep these existing settings:

- `PDL_PUBLIC_URL=https://app.prodailylink.com` so the issuer and metadata match the public origin.
- `PDL_REQUIRE_AUTH=1`
- Supabase enabled (`PDL_SUPABASE_ENABLED=1`), which is already set on Render. The OAuth clients and tokens live in `data/mcp-oauth.json` and are mirrored to a private Supabase snapshot marked `mcpConnector`. Render’s disk is ephemeral, so that mirror is what survives a restart. The snapshot is not a customer company and is excluded from the founder console, revenue, and backup audit.

Optional: `PDL_MCP_RATE_LIMIT` (requests per minute per signed-in user, default 60).

Merging this change to `main` deploys project manager access. Do that only when you intend to publish it.
