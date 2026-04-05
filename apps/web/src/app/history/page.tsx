"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Loader2, Mic } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card";
import { useAuth } from "@/context/auth";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecordingSummary {
  id: string;
  sessionId: string;
  status: string;
  language: string | null;
  totalChunks: number;
  createdAt: string;
  fullText: string | null;
}

interface TranscriptionChunk {
  sequenceNumber: number;
  text: string;
  noSpeech: boolean;
  language: string | null;
}

interface FullTranscription {
  status: string;
  language: string | null;
  totalChunks: number;
  transcribedChunks: number;
  fullText: string;
  chunks: TranscriptionChunk[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    transcribed: "bg-emerald-500/15 text-emerald-600",
    transcribing: "bg-blue-500/15 text-blue-600",
    complete: "bg-yellow-500/15 text-yellow-600",
    recording: "bg-red-500/15 text-red-600",
    error: "bg-destructive/15 text-destructive",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {status}
    </span>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDuration(totalChunks: number) {
  const secs = totalChunks * 5;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Recording card ───────────────────────────────────────────────────────────

function RecordingCard({
  recording,
  token,
}: {
  recording: RecordingSummary;
  token: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<FullTranscription | null>(null);
  const [loading, setLoading] = useState(false);

  const canExpand = recording.status === "transcribed";

  const handleExpand = async () => {
    if (!canExpand) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (full) return; // already loaded

    setLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings/${recording.id}/transcription`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setFull(await res.json());
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {statusBadge(recording.status)}
              {recording.language && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs uppercase">
                  {recording.language}
                </span>
              )}
            </div>
            <CardDescription className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {formatDate(recording.createdAt)}
              </span>
              <span className="flex items-center gap-1">
                <Mic className="size-3" />
                {recording.totalChunks} chunks · {formatDuration(recording.totalChunks)}
              </span>
            </CardDescription>
          </div>

          {canExpand && (
            <button
              type="button"
              onClick={handleExpand}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={expanded ? "Collapse" : "Expand transcript"}
            >
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          )}
        </div>

        {/* Preview — shown when collapsed */}
        {!expanded && recording.fullText && (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {recording.fullText}
          </p>
        )}
      </CardHeader>

      {/* Full transcript — shown when expanded */}
      {expanded && (
        <CardContent className="flex flex-col gap-3 pt-0">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading transcript…
            </div>
          )}

          {full && (
            <>
              {/* Full assembled text */}
              {full.fullText && (
                <p className="rounded-sm border border-border/50 bg-muted/20 p-3 text-sm leading-relaxed">
                  {full.fullText}
                </p>
              )}

              {/* Per-chunk breakdown */}
              <div className="flex flex-col gap-1">
                {full.chunks.map((t) => (
                  <div key={t.sequenceNumber} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 shrink-0 font-mono text-muted-foreground tabular-nums">
                      #{t.sequenceNumber}
                    </span>
                    {t.noSpeech ? (
                      <span className="italic text-muted-foreground/60">[silence]</span>
                    ) : (
                      <span>{t.text}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { token, isAuthenticated } = useAuth();
  const router = useRouter();

  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (!token) return;

    fetch(`${SERVER_URL}/api/recordings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => setRecordings(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [token]);

  if (!isAuthenticated) return null;

  return (
    <div className="container mx-auto flex max-w-lg flex-col gap-4 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Past recordings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All your recordings and transcriptions, newest first.
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      )}

      {!loading && recordings.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No recordings yet. Head to the{" "}
          <a href="/recorder" className="underline underline-offset-2">
            Recorder
          </a>{" "}
          to get started.
        </p>
      )}

      {recordings.map((rec) => (
        <RecordingCard key={rec.id} recording={rec} token={token!} />
      ))}
    </div>
  );
}
