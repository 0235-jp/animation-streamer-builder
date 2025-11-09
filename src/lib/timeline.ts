import type {
  AudioSegment,
  ClipAsset,
  MotionType,
  TalkPlan,
  TimelinePlan,
  TimelinePlacement,
} from '../types'

interface ClipLibrary {
  idle: ClipAsset[]
  idleToSpeech: ClipAsset[]
  speechLoop: ClipAsset[]
  speechToIdle: ClipAsset[]
}

const nextIndex = (counter: Record<MotionType, number>, type: MotionType) => {
  const value = counter[type]
  counter[type] = value + 1
  return value
}

export const buildTimelinePlan = (segments: AudioSegment[], clips: ClipAsset[]): TimelinePlan => {
  const library = groupClips(clips)
  if (!library.idle.length) throw new Error('Idle clips are required')
  if (!library.speechLoop.length) throw new Error('Speech-loop clips are required')

  const placements: TimelinePlacement[] = []
  const talkPlans: TalkPlan[] = []
  let videoCursor = 0
  let previousKind: 'idle' | 'talk' = 'idle'

  const counters: Record<MotionType, number> = {
    idle: 0,
    idleToSpeech: 0,
    speechLoop: 0,
    speechToIdle: 0,
  }

  const takeClip = (type: MotionType): ClipAsset => {
    const list = library[type]
    if (!list.length) throw new Error(`Missing clip for state: ${type}`)
    const clip = list[nextIndex(counters, type) % list.length]
    placements.push({ clip, start: videoCursor })
    videoCursor += clip.duration
    return clip
  }

  const maybeTakeClip = (type: MotionType): ClipAsset | null => {
    if (!library[type].length) return null
    return takeClip(type)
  }

  const coverSegment = (segment: AudioSegment) => {
    let covered = 0
    while (covered + 1e-2 < segment.duration) {
      const clip = takeClip(segment.kind === 'idle' ? 'idle' : 'speechLoop')
      covered += clip.duration
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    if (segment.kind === 'idle') {
      coverSegment(segment)
      previousKind = 'idle'
      continue
    }

    if (previousKind === 'idle') {
      maybeTakeClip('idleToSpeech')
    }

    const segmentVideoStart = videoCursor
    coverSegment(segment)
    talkPlans.push({
      segmentId: segment.id,
      videoStart: segmentVideoStart,
      videoEnd: videoCursor,
      audioStart: segment.start,
      audioDuration: segment.duration,
    })

    const nextSegment = segments[i + 1]
    if (!nextSegment || nextSegment.kind === 'idle') {
      maybeTakeClip('speechToIdle')
      previousKind = 'idle'
    } else {
      previousKind = 'talk'
    }
  }

  return {
    placements,
    talkPlans,
    totalDuration: videoCursor,
  }
}

export const groupClips = (clips: ClipAsset[]): ClipLibrary =>
  clips.reduce<ClipLibrary>(
    (acc, clip) => {
      acc[clip.type].push(clip)
      return acc
    },
    {
      idle: [],
      idleToSpeech: [],
      speechLoop: [],
      speechToIdle: [],
    }
  )
