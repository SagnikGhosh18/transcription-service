# Planning: Reliable Recording Chunking + Transcription Pipeline

## Project Goal

Build a reliable audio recording pipeline where:
- Recording data is **never lost** under any failure condition (network drop, tab close, crash)
- Every audio chunk is **transcribed accurately** with no hallucinations and no missing chunks
- The system handles **300,000 requests** at sustained 5,000 req/s under load

---

## Full Architecture

```
Browser
  │
  ├─ Record audio → chunk every 5s (16kHz, 16-bit PCM WAV)
  ├─ Save each chunk to OPFS (durable local buffer before any network call)
  ├─ POST /api/chunks/upload  (multipart: recordingId, seqNum, WAV blob)
  │     └─ On ack → mark chunk as safe (keep in OPFS until confirmed)
  │
  ├─ POST /api/recordings/:id/complete  (when stop is pressed)
  │
  └─ GET  /api/recordings/:id/transcription  (poll for results every 2s)
       └─ GET /api/recordings/:id/reconcile  (on reconnect — re-upload missing chunks from OPFS)

Server
  │
  ├─ Chunk Upload Handler
  │     ├─ Store WAV blob → bucket (Cloudflare R2 / MinIO)
  │     └─ Write chunk record → PostgreSQL (status: uploaded)
  │
  ├─ Complete Handler
  │     └─ Marks recording complete, kicks off sequential transcription job (async)
  │
  ├─ Transcription Service  ← ZERO HALLUCINATION DESIGN (see below)
  │     ├─ Process chunks in strict sequenceNumber order (never parallel)
  │     ├─ For each chunk:
  │     │     ├─ Fetch WAV from bucket
  │     │     ├─ Call Gemini: temperature=0, structured JSON output, language lock
  │     │     ├─ If hasSpeech=false → mark as silence, store empty text, skip prompt chain update
  │     │     ├─ Prompt chain: pass last ~200 chars of previous chunk as context
  │     │     └─ Store result in DB (text, hasSpeech, language, promptUsed)
  │     └─ Mark recording as "transcribed", assemble full transcript
  │
  └─ Reconcile Handler
        ├─ For each chunk in DB → HeadObject check in bucket
        └─ Return list of missing chunk seqNums (client re-uploads from OPFS)
```

---

## Zero-Hallucination Transcription Guarantees

| Technique | What it prevents |
|-----------|-----------------|
| `temperature: 0` | Removes all sampling randomness — fully deterministic output |
| Structured JSON output (`{ hasSpeech: boolean, text: string, language: string }`) | Gemini cannot return freeform hallucinated text; schema-constrained |
| Strict system prompt | *"If there is no audible speech, return hasSpeech: false and empty text. Never invent or guess content."* |
| Prompt chaining (last ~200 chars of previous chunk) | Prevents word-boundary hallucinations between chunk boundaries |
| Language locking | Auto-detect from first non-silent chunk, pass explicitly for all subsequent — prevents language switching mid-recording |
| Sequential processing only | Prompt chain is always coherent; never parallelize transcription |
| Idempotency check | Won't re-transcribe a completed chunk — safe to retry on failure |

---

## Database Schema

### `recordings`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `sessionId` | text UNIQUE | Client-generated before recording starts |
| `status` | enum | `recording \| complete \| transcribing \| transcribed \| error` |
| `language` | text | Detected from first non-silent chunk, locked for rest |
| `totalChunks` | int | |
| `createdAt`, `updatedAt` | timestamp | |

### `chunks`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `recordingId` | uuid FK→recordings | |
| `sequenceNumber` | int | 0-indexed, strict ordering enforced by unique index |
| `bucketKey` | text | e.g. `recordings/{recordingId}/chunk-{seqNum}.wav` |
| `sizeBytes` | int | |
| `durationMs` | int | |
| `status` | enum | `uploaded \| acked \| missing \| recovered` |
| `createdAt` | timestamp | |
| UNIQUE | `(recordingId, sequenceNumber)` | Prevents duplicate chunks |

### `transcriptions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `chunkId` | uuid FK→chunks UNIQUE | One transcription per chunk |
| `recordingId` | uuid FK→recordings | |
| `text` | text | Empty string when `noSpeech=true` |
| `noSpeech` | bool | True when silence/noise detected |
| `language` | text | Language detected for this chunk |
| `promptUsed` | text | The tail from previous chunk used as context |
| `createdAt` | timestamp | |

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/recordings` | Create session, returns `{ id, sessionId }` |
| `POST` | `/api/recordings/:id/complete` | Mark done, triggers transcription job |
| `GET` | `/api/recordings/:id` | Get status + metadata |
| `POST` | `/api/chunks/upload` | Upload WAV chunk (multipart), returns `{ chunkId }` |
| `GET` | `/api/recordings/:id/reconcile` | Returns array of missing chunk seqNums |
| `GET` | `/api/recordings/:id/transcription` | Returns `{ status, fullText, chunks[] }` |

---

## Files to Create / Modify

```
packages/db/src/schema/index.ts          ← recordings, chunks, transcriptions tables

packages/env/src/server.ts               ← add: GEMINI_API_KEY, BUCKET_ENDPOINT,
                                            BUCKET_ACCESS_KEY, BUCKET_SECRET_KEY,
                                            BUCKET_NAME

apps/server/package.json                 ← add: @google/genai, @aws-sdk/client-s3

apps/server/src/
  index.ts                               ← mount new route groups
  routes/
    recordings.ts                        ← POST /, POST /:id/complete, GET /:id
    chunks.ts                            ← POST /upload
    transcribe.ts                        ← GET /:recordingId (status + results)
  services/
    bucket.ts                            ← uploadChunk, getChunk, chunkExists (HeadObject)
    transcription.ts                     ← transcribeRecording — sequential, zero-hallucination

apps/web/src/
  hooks/use-recorder.ts                  ← add: sequenceNumber per chunk, OPFS save before upload,
                                            auto-upload per chunk, uploadStatus per chunk
  app/recorder/page.tsx                  ← add: upload status badges, transcription results panel,
                                            reconcile on reconnect

apps/server/.env.example                 ← document all required env vars
```

---

## New Dependencies

### `apps/server/package.json`

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini SDK — audio transcription with structured output |
| `@aws-sdk/client-s3` | S3-compatible bucket ops (MinIO / Cloudflare R2) — PutObject, GetObject, HeadObject |

> `@aws-sdk/lib-storage` is **not needed** — each chunk is ~160KB (5s × 16kHz × 16-bit PCM), well under any single-PUT limit.

### No new web dependencies
OPFS is a browser-native API (`navigator.storage.getDirectory()`), no package needed.

---

## Client-Side Changes (`use-recorder.ts`)

- Add `sequenceNumber` counter (increments per chunk, 0-indexed)
- Add `uploadStatus` per chunk: `pending | uploading | uploaded | failed`
- Add `sessionId` (UUID generated once when recording starts)
- On each chunk creation:
  1. Save WAV to OPFS: `recordings/{sessionId}/chunk-{seqNum}.wav`
  2. POST to `/api/chunks/upload`
  3. On 200 ack → update status to `uploaded`
  4. On failure → keep in OPFS, mark as `failed` for retry
- On reconnect → run reconcile → re-upload failed chunks from OPFS

---

## Recorder Page Changes

- Show upload status badge per chunk (spinner / green check / red retry)
- After recording completes → poll `/api/recordings/:id/transcription` every 2s
- Display assembled full transcript
- Show silence indicators for silent chunks (no text, labelled "silence")

---

## Hosting Plan

### Recommended (simplest)

| Component | Service | Notes |
|-----------|---------|-------|
| Next.js frontend | **Vercel** | Zero-config, Turborepo-aware, set root to `/`, framework to Next.js |
| Hono + Bun backend | **Railway** | Native Bun support, no Dockerfile needed |
| PostgreSQL | **Railway** (addon) | Same platform as backend, auto-injects `DATABASE_URL` |
| Storage bucket | **Cloudflare R2** | S3-compatible (no code changes), no egress fees, 10GB free tier |

### Alternative (all-in-one)

| Component | Service |
|-----------|---------|
| Next.js + Hono/Bun | Fly.io (Docker-based, great Bun support) |
| PostgreSQL | Neon (serverless Postgres, generous free tier) |
| Storage | Tigris (native Fly.io S3-compatible storage, zero config) |

### Why Cloudflare R2 for the bucket

- S3-compatible API — zero changes to bucket service code
- **No egress fees** — audio is read back for every transcription call; costs add up fast on AWS S3
- 10GB free, then $0.015/GB
- Works with `@aws-sdk/client-s3` via `endpoint: "https://<account>.r2.cloudflarestorage.com"` + `forcePathStyle: true`

### MinIO (local dev only)

MinIO is used for local development via Docker (`packages/db/docker-compose.yml` pattern).
For production, swap the endpoint env var to R2 or AWS S3 — bucket service code is unchanged.

### Monorepo Deployment Config

- **Vercel**: auto-detects `apps/web`, set build root to `/`, framework to Next.js, output dir to `apps/web/.next`
- **Railway**: point service root at `apps/server`, start command: `bun run src/index.ts`

---

## Load Testing Target

- **300,000 total requests** at **5,000 req/s** sustained for 60s
- Tool: k6 (see README for script)
- Validate: no dropped chunks, every DB ack has matching bucket object, reconciliation catches any mismatches
