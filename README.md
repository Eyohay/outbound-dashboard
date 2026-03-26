# Outbound Team Capacity Dashboard

A real-time sales team capacity dashboard built with Node.js + Express. Pulls live data from Airtable and displays meeting load, rep heat maps, proposal hit rates, and booking recommendations — auto-refreshing every 60 seconds.

## Run locally

```bash
npm install
node server.js
```

Then open **http://localhost:3000**

## Environment variables

Create a `.env` file in the project root (copy from `.env.example`):

| Variable | Description |
|---|---|
| `AIRTABLE_TOKEN` | Airtable personal access token |
| `AIRTABLE_BASE_CALLS` | Base ID for the Booked Calls table (starts with `app`) |

Optional overrides:

| Variable | Default | Description |
|---|---|---|
| `AIRTABLE_BASE_DOMAIN` | same as `AIRTABLE_BASE_CALLS` | Base ID if reps table is in a different base |
| `MEETINGS_TABLE` | `All Booked Calls` | Name of the meetings table |
| `REPS_TABLE` | `Sales Team` | Name of the reps table |
| `PORT` | `3000` | HTTP port (set automatically by Railway) |

## Deploy to Railway

1. Push this repo to GitHub (see commands below)
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select the `outbound-dashboard` repository
5. Go to the **Variables** tab and add:
   - `AIRTABLE_TOKEN` = your Airtable personal access token
   - `AIRTABLE_BASE_CALLS` = your base ID (e.g. `appXXXXXXXXXXXXXX`)
6. Click **Deploy** — Railway auto-detects Node.js and runs `npm start`
7. Go to **Settings → Networking → Generate Domain** to get your public URL

Railway will redeploy automatically on every `git push`.

## Git + GitHub setup commands

```bash
# 1. Initialize repo
git init

# 2. Stage all files
git add .

# 3. First commit
git commit -m "Initial commit: Outbound Team Capacity Dashboard"

# 4. Create GitHub repo and push (requires GitHub CLI)
gh repo create outbound-dashboard --public --push --source=.
```

## Health check

```
GET /health
→ { "status": "ok", "timestamp": "2026-03-26T..." }
```
