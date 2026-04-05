import { useCallback, useEffect, useRef, useState } from "react"

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096

export interface WavChunk {
  id: string
  blob: Blob
  url: string
  duration: number
  timestamp: number
  sequenceNumber: number
  uploadStatus: "pending" | "uploading" | "uploaded" | "failed"
  serverId?: string  // chunk ID assigned by the server on ack
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused"

interface UseRecorderOptions {
  chunkDuration?: number
  deviceId?: string
  serverUrl?: string
  authToken?: string | null
}

// ─── WAV encoding ─────────────────────────────────────────────────────────────

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const srcIndex = i * ratio
    const low = Math.floor(srcIndex)
    const high = Math.min(low + 1, input.length - 1)
    const frac = srcIndex - low
    output[i] = input[low] * (1 - frac) + input[high] * frac
  }
  return output
}

// ─── OPFS helpers ─────────────────────────────────────────────────────────────
// Each chunk is written to OPFS before any network call, guaranteeing
// the audio is recoverable even if the upload fails or the tab closes.

async function saveToOpfs(sessionId: string, seqNum: number, blob: Blob): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const sessionDir = await root.getDirectoryHandle(sessionId, { create: true })
    const fileHandle = await sessionDir.getFileHandle(`chunk-${seqNum}.wav`, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
  } catch (err) {
    console.warn("[OPFS] save failed:", err)
  }
}

async function readFromOpfs(sessionId: string, seqNum: number): Promise<Blob | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const sessionDir = await root.getDirectoryHandle(sessionId)
    const fileHandle = await sessionDir.getFileHandle(`chunk-${seqNum}.wav`)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

async function deleteFromOpfs(sessionId: string, seqNum: number): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const sessionDir = await root.getDirectoryHandle(sessionId)
    await sessionDir.removeEntry(`chunk-${seqNum}.wav`)
  } catch {
    // Ignore — file may already be gone
  }
}

// ─── Upload helper ────────────────────────────────────────────────────────────

async function uploadChunkToServer(
  serverUrl: string,
  recordingId: string,
  seqNum: number,
  durationMs: number,
  blob: Blob,
  authToken?: string | null,
): Promise<{ chunkId: string }> {
  const form = new FormData()
  form.append("recordingId", recordingId)
  form.append("sequenceNumber", String(seqNum))
  form.append("durationMs", String(durationMs))
  form.append("file", blob, `chunk-${seqNum}.wav`)

  const headers: Record<string, string> = {}
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`

  const res = await fetch(`${serverUrl}/api/chunks/upload`, {
    method: "POST",
    headers,
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Upload ${seqNum} failed (${res.status}): ${text}`)
  }

  return res.json() as Promise<{ chunkId: string }>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRecorder(options: UseRecorderOptions = {}) {
  const { chunkDuration = 5, deviceId, serverUrl, authToken } = options

  const [status, setStatus] = useState<RecorderStatus>("idle")
  const [chunks, setChunks] = useState<WavChunk[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const chunkThreshold = SAMPLE_RATE * chunkDuration
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const pausedElapsedRef = useRef(0)
  const statusRef = useRef<RecorderStatus>("idle")
  const seqRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)
  const recordingIdRef = useRef<string | null>(null)

  statusRef.current = status

  // ── Persist + upload a finalized WAV blob ──────────────────────────────────
  const persistAndUpload = useCallback(
    async (blob: Blob, seqNum: number, durationMs: number) => {
      const sid = sessionIdRef.current
      const rid = recordingIdRef.current

      // 1. Always save to OPFS first — guarantees recovery on failure
      if (sid) await saveToOpfs(sid, seqNum, blob)

      // 2. Update upload status to uploading
      setChunks((prev) =>
        prev.map((c) =>
          c.sequenceNumber === seqNum ? { ...c, uploadStatus: "uploading" } : c,
        ),
      )

      // 3. Upload to server (if server URL + recording ID are known)
      if (!serverUrl || !rid) return

      try {
        const { chunkId } = await uploadChunkToServer(serverUrl, rid, seqNum, durationMs, blob, authToken)

        // 4. Ack received — safe to remove from OPFS
        if (sid) await deleteFromOpfs(sid, seqNum)

        setChunks((prev) =>
          prev.map((c) =>
            c.sequenceNumber === seqNum
              ? { ...c, uploadStatus: "uploaded", serverId: chunkId }
              : c,
          ),
        )
      } catch (err) {
        console.error("[upload] chunk", seqNum, "failed:", err)
        // Keep in OPFS — user can reconcile later
        setChunks((prev) =>
          prev.map((c) =>
            c.sequenceNumber === seqNum ? { ...c, uploadStatus: "failed" } : c,
          ),
        )
      }
    },
    [serverUrl],
  )

  // ── Flush current sample buffer as a chunk ─────────────────────────────────
  const flushChunk = useCallback(() => {
    if (samplesRef.current.length === 0) return

    const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const buf of samplesRef.current) {
      merged.set(buf, offset)
      offset += buf.length
    }
    samplesRef.current = []
    sampleCountRef.current = 0

    const blob = encodeWav(merged, SAMPLE_RATE)
    const url = URL.createObjectURL(blob)
    const seqNum = seqRef.current++
    const durationMs = Math.round((merged.length / SAMPLE_RATE) * 1000)

    const chunk: WavChunk = {
      id: crypto.randomUUID(),
      blob,
      url,
      duration: merged.length / SAMPLE_RATE,
      timestamp: Date.now(),
      sequenceNumber: seqNum,
      uploadStatus: "pending",
    }

    setChunks((prev) => [...prev, chunk])
    persistAndUpload(blob, seqNum, durationMs)
  }, [persistAndUpload])

  // ── Start recording ────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (statusRef.current === "recording") return

    setStatus("requesting")
    try {
      // Generate a new session ID and create recording on server
      const sid = crypto.randomUUID()
      sessionIdRef.current = sid
      setSessionId(sid)
      seqRef.current = 0

      if (serverUrl) {
        const res = await fetch(`${serverUrl}/api/recordings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ sessionId: sid }),
        })
        if (res.ok) {
          const { id } = (await res.json()) as { id: string }
          recordingIdRef.current = id
          setRecordingId(id)
        }
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      })

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(mediaStream)
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      const nativeSampleRate = audioCtx.sampleRate

      processor.onaudioprocess = (e) => {
        if (statusRef.current !== "recording") return

        const input = e.inputBuffer.getChannelData(0)
        const resampled = resample(new Float32Array(input), nativeSampleRate, SAMPLE_RATE)

        samplesRef.current.push(resampled)
        sampleCountRef.current += resampled.length

        if (sampleCountRef.current >= chunkThreshold) {
          const totalLen = samplesRef.current.reduce((n, b) => n + b.length, 0)
          const merged = new Float32Array(totalLen)
          let off = 0
          for (const buf of samplesRef.current) {
            merged.set(buf, off)
            off += buf.length
          }
          samplesRef.current = []
          sampleCountRef.current = 0

          const blob = encodeWav(merged, SAMPLE_RATE)
          const url = URL.createObjectURL(blob)
          const seqNum = seqRef.current++
          const durationMs = Math.round((merged.length / SAMPLE_RATE) * 1000)

          const chunk: WavChunk = {
            id: crypto.randomUUID(),
            blob,
            url,
            duration: merged.length / SAMPLE_RATE,
            timestamp: Date.now(),
            sequenceNumber: seqNum,
            uploadStatus: "pending",
          }

          setChunks((prev) => [...prev, chunk])
          persistAndUpload(blob, seqNum, durationMs)
        }
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      streamRef.current = mediaStream
      audioCtxRef.current = audioCtx
      processorRef.current = processor
      setStream(mediaStream)

      samplesRef.current = []
      sampleCountRef.current = 0
      pausedElapsedRef.current = 0
      startTimeRef.current = Date.now()
      setElapsed(0)
      setStatus("recording")

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(
            pausedElapsedRef.current + (Date.now() - startTimeRef.current) / 1000,
          )
        }
      }, 100)
    } catch {
      setStatus("idle")
    }
  }, [deviceId, chunkThreshold, serverUrl, persistAndUpload])

  // ── Stop recording ─────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    flushChunk()

    processorRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (audioCtxRef.current?.state !== "closed") {
      audioCtxRef.current?.close()
    }
    if (timerRef.current) clearInterval(timerRef.current)

    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
    setStream(null)
    setStatus("idle")

    // Mark recording as complete on the server to trigger transcription
    const rid = recordingIdRef.current
    if (serverUrl && rid) {
      fetch(`${serverUrl}/api/recordings/${rid}/complete`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      }).catch(
        (err) => console.error("[recordings] complete failed:", err),
      )
    }
  }, [flushChunk, serverUrl])

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000
    setStatus("paused")
  }, [])

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return
    startTimeRef.current = Date.now()
    setStatus("recording")
  }, [])

  const clearChunks = useCallback(() => {
    for (const c of chunks) URL.revokeObjectURL(c.url)
    setChunks([])
  }, [chunks])

  // Retry a specific failed chunk from OPFS
  const retryChunk = useCallback(
    async (seqNum: number) => {
      const sid = sessionIdRef.current
      const rid = recordingIdRef.current
      if (!sid || !rid || !serverUrl) return

      const blob = await readFromOpfs(sid, seqNum)
      if (!blob) return

      const chunk = chunks.find((c) => c.sequenceNumber === seqNum)
      if (!chunk) return

      const durationMs = Math.round(chunk.duration * 1000)
      await persistAndUpload(blob, seqNum, durationMs)
    },
    [chunks, serverUrl, persistAndUpload],
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      processorRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (audioCtxRef.current?.state !== "closed") {
        audioCtxRef.current?.close()
      }
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  return {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    clearChunks,
    retryChunk,
    sessionId,
    recordingId,
  }
}
