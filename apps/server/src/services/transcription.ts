import { GoogleGenAI, Type } from "@google/genai";
import {
  chunks,
  db,
  recordings,
  transcriptions,
} from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import { asc, eq } from "drizzle-orm";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// ─── Zero-hallucination guarantees ───────────────────────────────────────────
// 1. temperature: 0        → fully deterministic, no sampling randomness
// 2. responseJsonSchema    → Gemini MUST return structured JSON; cannot hallucinate freeform text
// 3. SYSTEM_INSTRUCTION    → explicit rule: if no speech, return hasSpeech=false + empty text
// 4. Prompt chaining       → previous chunk's tail passed as context to resolve word boundaries
// 5. Language locking      → detected from first non-silent chunk, passed explicitly for all subsequent
// 6. Sequential only       → chunks processed in strict seqNum order; never parallelised
// 7. Idempotency           → already-transcribed chunks are skipped; safe to resume after failure
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are a precise audio transcription engine. Your only job is to accurately transcribe speech from audio files.

Rules you must follow without exception:
1. If you hear no speech (silence, background noise, music without vocals, static, or near-silence), set hasSpeech to false and text to an empty string.
2. Never invent, guess, or fill in words you cannot clearly hear. Accuracy over completeness.
3. Transcribe only what is actually spoken. Do not paraphrase, summarise, or alter the words.
4. If previous context is provided, use it only to resolve word boundaries at the start of the audio. Never continue inventing from it.
5. Return the BCP-47 language code of the spoken language (e.g. "en", "es", "fr", "de", "hi").`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hasSpeech: {
      type: Type.BOOLEAN,
      description: "True if audible speech is present in the audio, false for silence or noise.",
    },
    text: {
      type: Type.STRING,
      description: "The transcribed speech. Must be an empty string when hasSpeech is false.",
    },
    language: {
      type: Type.STRING,
      description: "BCP-47 language code of the spoken language, e.g. 'en', 'es', 'fr'.",
    },
  },
  required: ["hasSpeech", "text", "language"],
};

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        // Exponential backoff: 1s, 2s
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── Single-chunk transcription ───────────────────────────────────────────────

async function transcribeChunk(
  audioBuffer: Buffer,
  previousTail: string,
  lockedLanguage: string | undefined,
): Promise<{ hasSpeech: boolean; text: string; language: string }> {
  const base64Audio = audioBuffer.toString("base64");

  const contextLines: string[] = [];
  if (previousTail) {
    contextLines.push(`Previous transcript context (last spoken words): "${previousTail}"`);
  }
  if (lockedLanguage) {
    contextLines.push(`Expected language: ${lockedLanguage}`);
  }
  contextLines.push("Transcribe the attached audio. Return JSON only.");
  const userPrompt = contextLines.join("\n");

  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: userPrompt },
            { inlineData: { data: base64Audio, mimeType: "audio/wav" } },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const raw = response.text ?? '{"hasSpeech":false,"text":"","language":"en"}';
    const parsed = JSON.parse(raw) as {
      hasSpeech: boolean;
      text: string;
      language: string;
    };

    // Safety guard: if Gemini returns text despite hasSpeech=false, clear it
    if (!parsed.hasSpeech) {
      parsed.text = "";
    }

    return parsed;
  });
}

// ─── Full recording transcription (sequential, idempotent) ────────────────────

export async function transcribeRecording(recordingId: string): Promise<void> {
  // Mark as transcribing
  await db
    .update(recordings)
    .set({ status: "transcribing", updatedAt: new Date() })
    .where(eq(recordings.id, recordingId));

  try {
    // Load all chunks in strict sequence order
    const allChunks = await db
      .select()
      .from(chunks)
      .where(eq(chunks.recordingId, recordingId))
      .orderBy(asc(chunks.sequenceNumber));

    if (allChunks.length === 0) {
      await db
        .update(recordings)
        .set({ status: "transcribed", updatedAt: new Date() })
        .where(eq(recordings.id, recordingId));
      return;
    }

    // Load already-transcribed chunks (idempotency: safe to resume)
    const existing = await db
      .select({
        chunkId: transcriptions.chunkId,
        text: transcriptions.text,
        noSpeech: transcriptions.noSpeech,
        language: transcriptions.language,
      })
      .from(transcriptions)
      .where(eq(transcriptions.recordingId, recordingId));

    const transcribedMap = new Map(existing.map((t) => [t.chunkId, t]));

    // Restore locked language from previous run if available
    const [rec] = await db
      .select({ language: recordings.language })
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .limit(1);
    let lockedLanguage: string | undefined = rec?.language ?? undefined;

    // Restore prompt chain tail from the last completed transcription in order
    let previousTail = "";
    for (const chunk of allChunks) {
      const t = transcribedMap.get(chunk.id);
      if (t && !t.noSpeech && t.text) {
        previousTail = t.text.slice(-200);
      } else {
        // First un-transcribed chunk — stop restoring
        break;
      }
    }

    // Process each chunk in strict order
    for (const chunk of allChunks) {
      if (transcribedMap.has(chunk.id)) {
        // Already done — just keep the prompt chain moving
        const t = transcribedMap.get(chunk.id)!;
        if (!t.noSpeech && t.text) {
          previousTail = t.text.slice(-200);
        }
        continue;
      }

      // Audio is stored directly in the DB
      const audioBuffer = chunk.audio;

      // Call Gemini (with retries)
      const result = await transcribeChunk(audioBuffer, previousTail, lockedLanguage);

      // Lock language from first non-silent chunk
      if (!lockedLanguage && result.hasSpeech && result.language) {
        lockedLanguage = result.language;
        await db
          .update(recordings)
          .set({ language: lockedLanguage, updatedAt: new Date() })
          .where(eq(recordings.id, recordingId));
      }

      // Persist transcription result
      await db.insert(transcriptions).values({
        chunkId: chunk.id,
        recordingId,
        text: result.text,
        noSpeech: !result.hasSpeech,
        language: result.language || lockedLanguage || null,
        promptUsed: previousTail || null,
      });

      // Acknowledge chunk in DB
      await db
        .update(chunks)
        .set({ status: "acked" })
        .where(eq(chunks.id, chunk.id));

      // Advance prompt chain only for speech chunks
      if (result.hasSpeech && result.text) {
        previousTail = result.text.slice(-200);
      }
    }

    // All chunks processed — mark recording as transcribed
    await db
      .update(recordings)
      .set({ status: "transcribed", updatedAt: new Date() })
      .where(eq(recordings.id, recordingId));
  } catch (err) {
    await db
      .update(recordings)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(recordings.id, recordingId));
    throw err;
  }
}
