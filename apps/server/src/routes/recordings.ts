import { chunks, db, recordings, transcriptions } from "@my-better-t-app/db";
import { asc, desc, eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { transcribeRecording } from "../services/transcription";
import { authMiddleware, type AuthVariables } from "../middleware/auth";

export const recordingsRoute = new Hono<{ Variables: AuthVariables }>();

// All recording routes require authentication
recordingsRoute.use("/*", authMiddleware);

// ─── GET /api/recordings ──────────────────────────────────────────────────────
// List all recordings for the authenticated user, newest first.
// Includes a short transcript preview for transcribed recordings.
recordingsRoute.get("/", async (c) => {
  const userId = c.get("userId");

  const rows = await db
    .select({
      id: recordings.id,
      sessionId: recordings.sessionId,
      status: recordings.status,
      language: recordings.language,
      totalChunks: recordings.totalChunks,
      createdAt: recordings.createdAt,
    })
    .from(recordings)
    .where(eq(recordings.userId, userId))
    .orderBy(desc(recordings.createdAt));

  // For each transcribed recording, fetch the assembled full text
  const results = await Promise.all(
    rows.map(async (rec) => {
      if (rec.status !== "transcribed") return { ...rec, fullText: null };

      const chunkTexts = await db
        .select({ text: transcriptions.text, noSpeech: transcriptions.noSpeech })
        .from(transcriptions)
        .innerJoin(chunks, eq(transcriptions.chunkId, chunks.id))
        .where(eq(transcriptions.recordingId, rec.id))
        .orderBy(asc(chunks.sequenceNumber));

      const fullText = chunkTexts
        .filter((t) => !t.noSpeech && t.text)
        .map((t) => t.text.trim())
        .join(" ");

      return { ...rec, fullText };
    }),
  );

  return c.json(results);
});

// ─── POST /api/recordings ─────────────────────────────────────────────────────
// Create a new recording session. Called before recording starts.
recordingsRoute.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "sessionId is required" }, 400);
  }

  const [recording] = await db
    .insert(recordings)
    .values({ userId, sessionId: parsed.data.sessionId })
    .returning({ id: recordings.id, sessionId: recordings.sessionId });

  return c.json(recording, 201);
});

// ─── GET /api/recordings/:id ──────────────────────────────────────────────────
recordingsRoute.get("/:id", async (c) => {
  const userId = c.get("userId");

  const [recording] = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.id, c.req.param("id")), eq(recordings.userId, userId)))
    .limit(1);

  if (!recording) return c.json({ error: "Not found" }, 404);
  return c.json(recording);
});

// ─── POST /api/recordings/:id/complete ────────────────────────────────────────
// Mark recording complete and kick off background transcription.
recordingsRoute.post("/:id/complete", async (c) => {
  const userId = c.get("userId");

  const [recording] = await db
    .select({ id: recordings.id, status: recordings.status })
    .from(recordings)
    .where(and(eq(recordings.id, c.req.param("id")), eq(recordings.userId, userId)))
    .limit(1);

  if (!recording) return c.json({ error: "Not found" }, 404);
  if (recording.status !== "recording") {
    return c.json({ error: "Recording is not in recording state" }, 409);
  }

  await db
    .update(recordings)
    .set({ status: "complete", updatedAt: new Date() })
    .where(eq(recordings.id, recording.id));

  transcribeRecording(recording.id).catch((err) => {
    console.error(`[transcription] failed for recording ${recording.id}:`, err);
  });

  return c.json({ status: "complete", transcriptionStarted: true });
});

// ─── GET /api/recordings/:id/reconcile ───────────────────────────────────────
// Check all chunks exist in the bucket; return missing sequence numbers.
recordingsRoute.get("/:id/reconcile", async (c) => {
  const userId = c.get("userId");
  const recordingId = c.req.param("id");

  const [recording] = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, userId)))
    .limit(1);

  if (!recording) return c.json({ error: "Not found" }, 404);

  const allChunks = await db
    .select({ id: chunks.id, sequenceNumber: chunks.sequenceNumber, status: chunks.status })
    .from(chunks)
    .where(eq(chunks.recordingId, recordingId))
    .orderBy(asc(chunks.sequenceNumber));

  // With audio stored in PostgreSQL, a chunk is missing only if its status was marked so
  const missing = allChunks
    .filter((c) => c.status === "missing")
    .map((c) => c.sequenceNumber);

  return c.json({ total: allChunks.length, missingCount: missing.length, missingSequenceNumbers: missing });
});

// ─── GET /api/recordings/:id/transcription ────────────────────────────────────
// Poll for transcription status and full results.
recordingsRoute.get("/:id/transcription", async (c) => {
  const userId = c.get("userId");
  const recordingId = c.req.param("id");

  const [recording] = await db
    .select({ id: recordings.id, status: recordings.status, language: recordings.language, totalChunks: recordings.totalChunks })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, userId)))
    .limit(1);

  if (!recording) return c.json({ error: "Not found" }, 404);

  const chunkTranscriptions = await db
    .select({
      sequenceNumber: chunks.sequenceNumber,
      text: transcriptions.text,
      noSpeech: transcriptions.noSpeech,
      language: transcriptions.language,
    })
    .from(transcriptions)
    .innerJoin(chunks, eq(transcriptions.chunkId, chunks.id))
    .where(eq(transcriptions.recordingId, recordingId))
    .orderBy(asc(chunks.sequenceNumber));

  const fullText = chunkTranscriptions
    .filter((t) => !t.noSpeech && t.text)
    .map((t) => t.text.trim())
    .join(" ");

  return c.json({
    status: recording.status,
    language: recording.language,
    totalChunks: recording.totalChunks,
    transcribedChunks: chunkTranscriptions.length,
    fullText,
    chunks: chunkTranscriptions,
  });
});
