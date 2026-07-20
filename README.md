# Monday Bowling

Local-first Monday bowling roster, scoring, money settlement, and history.
Works on phone as a free home-screen app (PWA).

## Free cloud (phone anywhere)

For a small league this stays on the **free** tiers of:

| Service | Free forever? | What you get |
|---------|---------------|--------------|
| [Vercel Hobby](https://vercel.com/pricing) | Yes (personal / non-commercial) | Hosts the website |
| [Turso Free](https://turso.tech/pricing) | Yes within monthly quotas | Stores your SQLite data in the cloud |

Practical limits for this app: a few dozen people scoring once a week is tiny versus Turso’s free read/write quotas. If you somehow blow past free limits, Turso pauses the DB until you upgrade — it does not silently charge on Free.

### 1. Create a free Turso database

```powershell
# install CLI once
irm get.tur.so/install.ps1 | iex
turso auth login
turso db create monday-bowling
turso db show monday-bowling --url
turso db tokens create monday-bowling
```

Copy the URL and token into `.env.local` (and later into Vercel):

```
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

### 2. Deploy to Vercel (free)

```powershell
npm i -g vercel
vercel login
vercel
vercel env add TURSO_DATABASE_URL
vercel env add TURSO_AUTH_TOKEN
vercel --prod
```

Open the `*.vercel.app` URL on iPhone Safari → Share → **Add to Home Screen**.

## Run locally

```powershell
npm install
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`. Local data is stored in `data/bowling.db` unless Turso env vars are set.

## Verify

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
```
