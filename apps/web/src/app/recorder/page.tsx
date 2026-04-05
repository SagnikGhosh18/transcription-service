"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, Download, Loader2, Mic, Pause, Play, RefreshCw, Square, Trash2, XCircle } from "lucide-react"

import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { useAuth } from "@/context/auth"
import { useRecorder, type WavChunk } from "@/hooks/use-recorder"

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? ""

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptionChunk {
  sequenceNumber: number
  text: string
  noSpeech: boolean
  language: string | null
}

interface TranscriptionResult {
  status: string
  language: string | null
  totalChunks: number
  transcribedChunks: number
  fullText: string
  chunks: TranscriptionChunk[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`
}

// ─── Upload status badge ──────────────────────────────────────────────────────

function UploadBadge({ status, onRetry }: { status: WavChunk["uploadStatus"]; onRetry?: () => void }) {
  if (status === "uploaded") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-emerald-500">
        <CheckCircle2 className="size-3" /> Uploaded
      </span>
    )
  }
  if (status === "uploading") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Uploading
      </span>
    )
  }
  if (status === "failed") {
    return (
      <button type="button" onClick={onRetry} className="flex items-center gap-1 text-[10px] text-destructive hover:underline">
        <XCircle className="size-3" /> Failed — retry
      </button>
    )
  }
  return <span className="text-[10px] text-muted-foreground">Pending</span>
}

// ─── Chunk row ────────────────────────────────────────────────────────────────

function ChunkRow({ chunk, onRetry }: { chunk: WavChunk; onRetry: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) { el.pause(); el.currentTime = 0; setPlaying(false) }
    else { el.play(); setPlaying(true) }
  }

  const download = () => {
    const a = document.createElement("a")
    a.href = chunk.url
    a.download = `chunk-${chunk.sequenceNumber}.wav`
    a.click()
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <audio ref={audioRef} src={chunk.url} onEnded={() => setPlaying(false)} preload="none" />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">#{chunk.sequenceNumber}</span>
      <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
      <span className="text-[10px] text-muted-foreground">16kHz PCM</span>
      <UploadBadge status={chunk.uploadStatus} onRetry={onRetry} />
      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="icon-xs" onClick={toggle}>
          {playing ? <Square className="size-3" /> : <Play className="size-3" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={download}>
          <Download className="size-3" />
        </Button>
      </div>
    </div>
  )
}

// ─── Transcription panel ──────────────────────────────────────────────────────

function TranscriptionPanel({ recordingId, token }: { recordingId: string; token: string }) {
  const [result, setResult] = useState<TranscriptionResult | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/recordings/${recordingId}/transcription`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return
        const data = (await res.json()) as TranscriptionResult
        setResult(data)
        if (data.status === "transcribed" || data.status === "error") {
          if (intervalRef.current) clearInterval(intervalRef.current)
        }
      } catch { /* keep polling */ }
    }

    poll()
    intervalRef.current = setInterval(poll, 2000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [recordingId, token])

  if (!result) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Waiting for transcription…
      </div>
    )
  }

  const isInProgress = result.status === "transcribing" || result.status === "complete"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isInProgress && <Loader2 className="size-3 animate-spin" />}
          {result.status === "transcribed" && <CheckCircle2 className="size-3 text-emerald-500" />}
          {result.status === "error" && <XCircle className="size-3 text-destructive" />}
          <span className="capitalize">{result.status}</span>
          {result.language && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono uppercase">{result.language}</span>
          )}
        </span>
        <span>{result.transcribedChunks}/{result.totalChunks} chunks</span>
      </div>

      {result.fullText && (
        <p className="rounded-sm border border-border/50 bg-muted/20 p-3 text-sm leading-relaxed">
          {result.fullText}
        </p>
      )}

      {result.chunks.length > 0 && (
        <div className="flex flex-col gap-1">
          {result.chunks.map((t) => (
            <div key={t.sequenceNumber} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0 font-mono text-muted-foreground tabular-nums">
                #{t.sequenceNumber}
              </span>
              {t.noSpeech
                ? <span className="italic text-muted-foreground/60">[silence]</span>
                : <span>{t.text}</span>
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecorderPage() {
  const { isAuthenticated, token } = useAuth()
  const router = useRouter()
  const [deviceId] = useState<string | undefined>()
  const [completedRecordingId, setCompletedRecordingId] = useState<string | null>(null)

  // Auth guard
  useEffect(() => {
    if (!isAuthenticated) router.replace("/login")
  }, [isAuthenticated, router])

  const {
    status, start, stop, pause, resume,
    chunks, elapsed, stream,
    clearChunks, retryChunk, recordingId,
  } = useRecorder({ chunkDuration: 5, deviceId, serverUrl: SERVER_URL, authToken: token })

  const isRecording = status === "recording"
  const isPaused = status === "paused"
  const isActive = isRecording || isPaused

  const handlePrimary = useCallback(async () => {
    if (isActive) {
      const rid = recordingId
      await stop()
      if (rid) setCompletedRecordingId(rid)
    } else {
      setCompletedRecordingId(null)
      await start()
    }
  }, [isActive, stop, start, recordingId])

  if (!isAuthenticated) return null

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>16 kHz / 16-bit PCM WAV — chunked every 5 s</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          <div className="flex items-center justify-center gap-3">
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <><Square className="size-4" /> Stop</>
              ) : (
                <><Mic className="size-4" /> {status === "requesting" ? "Requesting…" : "Record"}</>
              )}
            </Button>

            {isActive && (
              <Button size="lg" variant="outline" className="gap-2" onClick={isPaused ? resume : pause}>
                {isPaused ? <><Play className="size-4" /> Resume</> : <><Pause className="size-4" /> Pause</>}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Chunks</CardTitle>
            <CardDescription>
              {chunks.length} recorded · {chunks.filter((c) => c.uploadStatus === "uploaded").length} uploaded
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk) => (
              <ChunkRow key={chunk.id} chunk={chunk} onRetry={() => retryChunk(chunk.sequenceNumber)} />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-1.5 self-end text-destructive"
              onClick={clearChunks}
            >
              <Trash2 className="size-3" /> Clear all
            </Button>
          </CardContent>
        </Card>
      )}

      {completedRecordingId && token && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Transcription
              <RefreshCw className="size-3.5 text-muted-foreground" />
            </CardTitle>
            <CardDescription>Powered by Gemini 2.0 Flash · zero hallucinations</CardDescription>
          </CardHeader>
          <CardContent>
            <TranscriptionPanel recordingId={completedRecordingId} token={token} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
