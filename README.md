# Dopamine Bowling

Weekly bowling league app for teams, scores, club pot, and history.
Works on iPhone as a home-screen app (PWA).

**Live:** https://monday-bowling.vercel.app  
**Repo:** https://github.com/yeon971105/Monday_Bowling

The production branch is **`master`**. Push there and Vercel updates the live site. You do not need Vercel or Turso keys to change the app.

## How it works

The UI is one page with three tabs.

| Tab | What it does |
|-----|----------------|
| **Play** | Check in bowlers, generate 2 or 3 teams, enter 3 games. A red **S** marks club members. A $10 scratch ticket goes out when a team of club members wins 2+ games that night. |
| **Club** | Membership is the source of truth — add or remove people only here. $20 dues on the 9th (America/Los_Angeles). **Paid out** is tickets plus money you record. **Ledger** is in/out by day. |
| **History** | Averages, wins, scratch tickets, weekly sessions. |

Local `npm run dev` uses `data/bowling.db`. Production uses Turso. Same code path, different database.

## Edit the code

1. Accept the GitHub invite, then clone **`master`**:

```powershell
git clone https://github.com/yeon971105/Monday_Bowling.git
cd Monday_Bowling
git checkout master
```

2. Install and run:

```powershell
npm install
npm run db:migrate
npm run dev
```

3. Open http://localhost:3000, change files, refresh the browser.

4. Before you push:

```powershell
npm run typecheck
npm test
```

### Where to change things

| If you want to change… | Edit |
|------------------------|------|
| Screens, tabs, Club / Paid out / Ledger | `src/app/page.tsx` |
| Look and layout | `src/app/globals.css` |
| Page title / PWA name | `src/app/layout.tsx`, `public/manifest.webmanifest` |
| API (save games, members, payouts) | `src/app/api/[...segments]/route.ts` |
| Team generator | `src/lib/generator.ts` |
| Scoring, next game, scratch winners | `src/lib/scoring.ts` |
| Dues, tickets, payouts, ledger | `src/lib/money.ts` |
| Database schema | `src/lib/db.ts` |
| Types | `src/lib/types.ts` |
| Tests | `tests/` |

Do not commit `.env*`, `auth`, `auth-wal`, or `data/*.db`. Those are secrets or local data.

## Put it on the server

The live site is already wired to this repo. You do **not** run `vercel` for a normal change.

```powershell
git checkout master
git pull
git add .
git commit -m "Explain what you changed and why."
git push origin master
```

Vercel builds that push and updates https://monday-bowling.vercel.app (about one minute). Check the deploy at https://vercel.com/job19/monday-bowling.

- Push to **`master`** → production.
- Push to any other branch → preview URL only. The live site does not change.
- Do not use the leftover empty `main` branch.

Turso keys stay on Vercel. Do not put them in GitHub.

## iPhone

1. Safari → https://monday-bowling.vercel.app
2. Share → **Add to Home Screen**
3. Open from the home icon

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | Local Next.js server |
| `npm run build` | Production build |
| `npm test` | Vitest |
| `npm run typecheck` | TypeScript |
| `npm run db:migrate` | Create / update local SQLite schema |
