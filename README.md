# Monday Bowling

Monday bowling roster, scoring, money settlement, and history.
Works on iPhone as a free home-screen app (PWA).

**Live:** https://monday-bowling.vercel.app

## Is the cloud really free?

For this small weekly league app, yes — stay on free plans:

| Service | Cost | Caveat |
|---------|------|--------|
| [Vercel Hobby](https://vercel.com/pricing) | $0 | Personal / non-commercial use |
| [Turso Free](https://turso.tech/pricing) | $0 | Monthly read/write/storage quotas (this app is tiny vs those limits) |

Free plans do **not** silently charge. If Turso free quota is ever exceeded, the DB pauses until you upgrade or the month resets.

## Finish Turso setup (required for data to persist)

The site is deployed, but you still need a free Turso database so scores/history survive.

1. Open https://app.turso.tech and sign up with GitHub (free).
2. Create a database named `monday-bowling`.
3. Copy **Database URL** and create an **Auth Token**.
4. In a terminal in this project folder:

```powershell
npx vercel env add TURSO_DATABASE_URL production
npx vercel env add TURSO_AUTH_TOKEN production
npx vercel --prod
```

Paste the URL and token when prompted, then redeploy.

## iPhone: use like an app

1. Safari → https://monday-bowling.vercel.app  
2. Share → **Add to Home Screen**  
3. Open from the home icon (fullscreen app style)

## Run locally

```powershell
npm install
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`. Local data is in `data/bowling.db` unless Turso env vars are set.

## Verify

```powershell
npm run typecheck
npm test
```
