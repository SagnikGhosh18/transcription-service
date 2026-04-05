import {
  boolean,
  customType,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// bytea column type for storing raw binary data in PostgreSQL
const bytea = customType<{ data: Buffer; notNull: true; default: false }>({
  dataType() {
    return "bytea";
  },
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Recordings ───────────────────────────────────────────────────────────────

export const recordingStatusEnum = pgEnum("recording_status", [
  "recording",
  "complete",
  "transcribing",
  "transcribed",
  "error",
]);

export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().unique(),
  status: recordingStatusEnum("status").notNull().default("recording"),
  // Locked to the language detected from the first non-silent chunk
  language: text("language"),
  totalChunks: integer("total_chunks").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Chunks ───────────────────────────────────────────────────────────────────

export const chunkStatusEnum = pgEnum("chunk_status", [
  "uploaded",
  "acked",
  "missing",
  "recovered",
]);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    // 0-indexed, strictly ordered. Unique per recording enforced below.
    sequenceNumber: integer("sequence_number").notNull(),
    // Raw WAV audio stored directly in PostgreSQL
    audio: bytea("audio").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    durationMs: integer("duration_ms").notNull(),
    status: chunkStatusEnum("status").notNull().default("uploaded"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("chunks_recording_seq_idx").on(t.recordingId, t.sequenceNumber),
  ],
);

// ─── Transcriptions ───────────────────────────────────────────────────────────

export const transcriptions = pgTable("transcriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  chunkId: uuid("chunk_id")
    .notNull()
    .unique()
    .references(() => chunks.id, { onDelete: "cascade" }),
  recordingId: uuid("recording_id")
    .notNull()
    .references(() => recordings.id, { onDelete: "cascade" }),
  // Empty string when noSpeech=true (silence/noise chunk)
  text: text("text").notNull(),
  noSpeech: boolean("no_speech").notNull().default(false),
  // BCP-47 language code e.g. "en", "es", "fr"
  language: text("language"),
  // Last ~200 chars of the previous chunk's transcript used as context prompt
  promptUsed: text("prompt_used"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
