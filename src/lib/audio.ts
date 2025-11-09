import type { AudioSegment, TalkPlan } from '../types'

const WINDOW_SIZE_SEC = 0.08
const SILENCE_HOLD_BLOCKS = 3
const MIN_SEGMENT_DURATION_SEC = 0.05
const TALK_GAP_TOLERANCE_SEC = 0.05

export interface AudioAnalysisResult {
  buffer: AudioBuffer
  segments: AudioSegment[]
  rmsValues: number[]
  windowDuration: number
  talkThreshold: number
  silenceThreshold: number
}

export async function analyzeAudio(file: File): Promise<AudioAnalysisResult> {
  const arrayBuffer = await file.arrayBuffer()
  const audioContext = new AudioContext()
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0))
  await audioContext.close()

  const sampleRate = audioBuffer.sampleRate
  const blockSize = Math.max(1, Math.floor(sampleRate * WINDOW_SIZE_SEC))
  const totalSamples = audioBuffer.length
  const blockCount = Math.ceil(totalSamples / blockSize)
  const windowDuration = blockSize / sampleRate

  const rmsValues: number[] = []
  const channelData = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
    audioBuffer.getChannelData(index)
  )

  for (let block = 0; block < blockCount; block++) {
    const start = block * blockSize
    const end = Math.min(start + blockSize, totalSamples)
    const length = end - start
    if (length <= 0) {
      rmsValues.push(0)
      continue
    }

    let sumSquares = 0
    for (let channel = 0; channel < channelData.length; channel++) {
      const data = channelData[channel]
      for (let i = start; i < end; i++) {
        const value = data[i]
        sumSquares += value * value
      }
    }

    const meanSquare = sumSquares / (length * channelData.length)
    rmsValues.push(Math.sqrt(meanSquare))
  }

  const sorted = [...rmsValues].sort((a, b) => a - b)
  const strongLevel = sorted[Math.max(0, Math.floor(sorted.length * 0.9) - 1)] ?? 0
  const talkThreshold = Math.max(0.02, strongLevel * 0.4)
  const silenceThreshold = talkThreshold * 0.55

  const segments: AudioSegment[] = []
  let currentKind: 'idle' | 'talk' = 'idle'
  let currentStart = 0
  let silenceBlocks = 0

  const flushSegment = (endTime: number) => {
    const duration = endTime - currentStart
    if (duration <= MIN_SEGMENT_DURATION_SEC) {
      currentStart = endTime
      return
    }
    segments.push({
      id: `${currentKind}-${segments.length}`,
      kind: currentKind,
      start: currentStart,
      duration,
    })
    currentStart = endTime
  }

  for (let block = 0; block < blockCount; block++) {
    const value = rmsValues[block]
    const blockEnd = Math.min(audioBuffer.duration, (block + 1) * windowDuration)

    if (currentKind === 'idle') {
      if (value >= talkThreshold) {
        flushSegment(block * windowDuration)
        currentKind = 'talk'
        silenceBlocks = 0
      }
    } else {
      if (value < silenceThreshold) {
        silenceBlocks++
        if (silenceBlocks >= SILENCE_HOLD_BLOCKS) {
          flushSegment(blockEnd)
          currentKind = 'idle'
          silenceBlocks = 0
        }
      } else {
        silenceBlocks = 0
      }
    }
  }

  flushSegment(audioBuffer.duration)

  if (!segments.length || segments[0].kind !== 'idle') {
    segments.unshift({
      id: 'idle-0',
      kind: 'idle',
      start: 0,
      duration: segments.length ? segments[0].start : audioBuffer.duration,
    })
  }

  const normalizedSegments = rebuildSegmentIds(mergeAdjacentTalkSegments(segments, TALK_GAP_TOLERANCE_SEC))

  return {
    buffer: audioBuffer,
    segments: normalizedSegments,
    rmsValues,
    windowDuration,
    talkThreshold,
    silenceThreshold,
  }
}

export function buildAlignedAudioBuffer(
  audioBuffer: AudioBuffer,
  talkPlans: TalkPlan[],
  totalDuration: number
): AudioBuffer {
  const sampleRate = audioBuffer.sampleRate
  const totalSamples = Math.ceil(totalDuration * sampleRate)
  const output = new AudioBuffer({
    numberOfChannels: audioBuffer.numberOfChannels,
    length: totalSamples,
    sampleRate,
  })

  for (const plan of talkPlans) {
    const sourceStart = Math.floor(plan.audioStart * sampleRate)
    const sourceSamples = Math.floor(plan.audioDuration * sampleRate)
    const targetStart = Math.floor(plan.videoStart * sampleRate)
    const remainingTarget = totalSamples - targetStart
    if (remainingTarget <= 0 || sourceSamples <= 0) continue

    const copyLength = Math.min(sourceSamples, remainingTarget, audioBuffer.length - sourceStart)
    if (copyLength <= 0) continue

    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const input = audioBuffer.getChannelData(channel).subarray(sourceStart, sourceStart + copyLength)
      output.getChannelData(channel).set(input, targetStart)
    }
  }

  return output
}

export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const format = 1 // PCM
  const bitDepth = 16

  const samples = buffer.length
  const blockAlign = (numChannels * bitDepth) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = samples * blockAlign
  const bufferSize = 44 + dataSize
  const arrayBuffer = new ArrayBuffer(bufferSize)
  const view = new DataView(arrayBuffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  const channelData = []
  for (let channel = 0; channel < numChannels; channel++) {
    channelData.push(buffer.getChannelData(channel))
  }

  for (let i = 0; i < samples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = channelData[channel][i]
      sample = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Uint8Array(arrayBuffer)
}

const writeString = (view: DataView, offset: number, text: string) => {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

export const formatSeconds = (value: number) => `${value.toFixed(2)}s`

const mergeAdjacentTalkSegments = (segments: AudioSegment[], gapTolerance: number) => {
  if (!segments.length) return segments
  const merged: AudioSegment[] = []
  for (const segment of segments) {
    if (!merged.length) {
      merged.push({ ...segment })
      continue
    }
    const prev = merged[merged.length - 1]
    const prevEnd = prev.start + prev.duration
    const gap = segment.start - prevEnd
    if (segment.kind === 'talk' && prev.kind === 'talk' && gap <= gapTolerance + 1e-6) {
      const newEnd = segment.start + segment.duration
      prev.duration = newEnd - prev.start
      continue
    }
    merged.push({ ...segment })
  }
  return merged
}

const rebuildSegmentIds = (segments: AudioSegment[]): AudioSegment[] =>
  segments.map((segment, index) => ({
    ...segment,
    id: `${segment.kind}-${index}`,
  }))
