import { chunks, db, recordings } from "@my-better-t-app/db";
import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { authMiddleware, type AuthVariables } from "../middleware/auth";

export const chunksRoute = new Hono<{ Variables: AuthVariables }>();

chunksRoute.use("/*", authMiddleware);

// ─── POST /api/chunks/upload ──────────────────────────────────────────────────
// Upload a single WAV chunk. Expects multipart/form-data:
//   - recordingId    (string)
//   - sequenceNumber (number, 0-indexed)
//   - durationMs     (number)
//   - file           (WAV Blob)
//
// The client only deletes the chunk from OPFS after receiving this ack.
chunksRoute.post("/upload", async (c) => {
  const userId = c.get("userId");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const recordingId = formData.get("recordingId") as string | null;
  const sequenceNumber = Number(formData.get("sequenceNumber"));
  const durationMs = Number(formData.get("durationMs"));
  const file = formData.get("file") as File | null;

  if (!recordingId || isNaN(sequenceNumber) || isNaN(durationMs) || !file) {
    return c.json(
      { error: "Missing required fields: recordingId, sequenceNumber, durationMs, file" },
      400,
    );
  }

  // Verify the recording exists and belongs to this user
  const [recording] = await db
    .select({ id: recordings.id, status: recordings.status })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, userId)))
    .limit(1);

  if (!recording) {
    return c.json({ error: "Recording not found" }, 404);
  }
  if (recording.status === "transcribed" || recording.status === "error") {
    return c.json({ error: "Recording is already finalised" }, 409);
  }

  const audioBuffer = Buffer.from(await file.arrayBuffer());

  // Store audio directly in PostgreSQL (idempotent: re-upload updates audio + status)
  const inserted = await db
    .insert(chunks)
    .values({
      recordingId,
      sequenceNumber,
      audio: audioBuffer,
      sizeBytes: audioBuffer.length,
      durationMs,
      status: "uploaded",
    })
    .onConflictDoUpdate({
      target: [chunks.recordingId, chunks.sequenceNumber],
      set: { audio: audioBuffer, status: "recovered", sizeBytes: audioBuffer.length },
    })
    .returning({ id: chunks.id });

  const chunk = inserted[0];
  if (!chunk) {
    return c.json({ error: "Failed to persist chunk" }, 500);
  }

  // 3. Sync totalChunks counter
  const [countRow] = await db
    .select({ value: count() })
    .from(chunks)
    .where(eq(chunks.recordingId, recordingId));

  await db
    .update(recordings)
    .set({ totalChunks: countRow?.value ?? 0, updatedAt: new Date() })
    .where(eq(recordings.id, recordingId));

  return c.json({ chunkId: chunk.id }, 201);
});
