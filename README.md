# Dopamine Bowling

Weekly bowling league app for teams, scores, club pot, and history.
Works on iPhone as a free home-screen app (PWA).

**Live:** https://monday-bowling.vercel.app

## Features

**Play**
- Check in who is bowling, generate 2 or 3 balanced teams, and enter 3 games
- A red **S** follows club members on setup, games, and History
- A $10 scratch ticket goes out when a team of club members wins 2+ games that night

**Club**
- Membership is the source of truth — add or remove people only here
- $20 dues on the 9th of each month (America/Los_Angeles)
- **Paid out** lists tickets and any money you recorded; Edit to add a payout
- **Ledger** shows in and out by day (who got paid stays in Paid out)

**History**
- Player averages, wins, scratch tickets, and weekly sessions

## Stack

Next.js 15, React 19, libsql (local SQLite or [Turso](https://turso.tech)), Vitest, Vercel.

## Run locally

```powershell
npm install
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Local data is `data/bowling.db` unless Turso env vars are set.

Copy `.env.example` to `.env.local` only if you want a remote database.

```powershell
npm run typecheck
npm test
```

## iPhone

1. Safari → https://monday-bowling.vercel.app
2. Share → **Add to Home Screen**
3. Open from the home icon

## Deploy (free)

| Service | Cost | Notes |
|---------|------|--------|
| [Vercel Hobby](https://vercel.com/pricing) | $0 | Personal / non-commercial |
| [Turso Free](https://turso.tech/pricing) | $0 | Enough for this weekly league |

1. Create a Turso database named `monday-bowling`.
2. Copy the database URL and an auth token.
3. Set them on Vercel, then deploy:

```powershell
npx vercel env add TURSO_DATABASE_URL production
npx vercel env add TURSO_AUTH_TOKEN production
npx vercel --prod
```

Do not commit `.env*`, `auth`, or `auth-wal`. Those hold credentials.

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | Local Next.js server |
| `npm run build` | Production build |
| `npm test` | Vitest |
| `npm run typecheck` | TypeScript |
| `npm run db:migrate` | Create / update local SQLite schema |
