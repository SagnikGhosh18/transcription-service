# Setup Guide

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [Bun](https://bun.sh) v1+
- [Docker](https://www.docker.com) (for local PostgreSQL)

---

## 1. Install dependencies

```bash
npm install
```

---

## 2. Configure environment variables

```bash
cp apps/server/.env.example apps/server/.env
```

Open `apps/server/.env` and fill in:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `CORS_ORIGIN` | Your frontend URL (default: `http://localhost:3001`) |
| `GEMINI_API_KEY` | Get one free at [aistudio.google.com](https://aistudio.google.com/apikey) |
| `JWT_SECRET` | A random secret ≥ 32 chars — run `openssl rand -hex 32` to generate one |

Also create `apps/web/.env.local`:

```bash
echo "NEXT_PUBLIC_SERVER_URL=http://localhost:3000" > apps/web/.env.local
```

---

## 3. Start PostgreSQL

```bash
npm run db:start
```

---

## 4. Push the database schema

```bash
npm run db:push
```

---

## 5. Run the app

```bash
npm run dev
```

- Frontend: http://localhost:3001
- API server: http://localhost:3000
- Database studio: `npm run db:studio`

---

## Stopping local services

```bash
npm run db:stop    # Stop PostgreSQL
npm run db:down    # Stop and remove container + volume
```

---

## Deployment

The recommended stack is **Vercel** (frontend) + **Railway** (backend + PostgreSQL). No separate object store is needed — audio is stored directly in PostgreSQL.

### Backend — Railway

1. Create a new project at [railway.app](https://railway.app)
2. Add a **PostgreSQL** service (Railway addon) — it auto-injects `DATABASE_URL`
3. Add a second service from your GitHub repo, set the **Root Directory** to `apps/server`
4. Railway will detect the `Dockerfile` automatically — no start command needed
5. Add environment variables in the Railway dashboard:

   | Variable | Value |
   |----------|-------|
   | `DATABASE_URL` | Auto-injected by Railway PostgreSQL addon |
   | `CORS_ORIGIN` | Your Vercel frontend URL (e.g. `https://your-app.vercel.app`) |
   | `GEMINI_API_KEY` | Your Google AI Studio key |
   | `JWT_SECRET` | Run `openssl rand -hex 32` and paste the result |
   | `NODE_ENV` | `production` |

6. After the first deploy, run the schema push once via Railway's shell or a one-off command:
   ```
   npx drizzle-kit push
   ```

### Frontend — Vercel

1. Import your GitHub repo at [vercel.com/new](https://vercel.com/new)
2. Set the **Root Directory** to `apps/web`
3. Framework preset: **Next.js** (auto-detected)
4. Add environment variables:

   | Variable | Value |
   |----------|-------|
   | `NEXT_PUBLIC_SERVER_URL` | Your Railway backend URL (e.g. `https://your-server.up.railway.app`) |

5. Deploy — Vercel handles the build automatically.

### After deployment

- Visit your Vercel URL, register an account, and start recording.
- The backend URL and CORS origin must match exactly (no trailing slash).
