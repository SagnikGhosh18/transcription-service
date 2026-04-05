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
