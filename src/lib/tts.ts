const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

const normalizeEndpoint = (value: string, label: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} を入力してください`)
  }
  return trimTrailingSlash(trimmed)
}

const assertBrowserApis = () => {
  if (typeof fetch !== 'function') throw new Error('fetch API が利用できません')
  if (typeof File !== 'function') throw new Error('File API が利用できません')
}

export interface VoicevoxRequestConfig {
  endpoint: string
  speakerId: number
}

export const synthesizeVoicevox = async (text: string, config: VoicevoxRequestConfig): Promise<File> => {
  assertBrowserApis()
  const normalizedText = text.trim()
  if (!normalizedText) throw new Error('読み上げテキストを入力してください')

  const endpoint = normalizeEndpoint(config.endpoint, 'VOICEVOX エンドポイント')
  const speakerId = Number.isFinite(config.speakerId) ? config.speakerId : 1
  const searchParams = new URLSearchParams({
    text: normalizedText,
    speaker: String(speakerId),
  })

  const queryResponse = await fetch(`${endpoint}/audio_query?${searchParams.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!queryResponse.ok) {
    const message = await safeReadText(queryResponse)
    throw new Error(`VOICEVOX audio_query が失敗しました (${queryResponse.status}): ${message}`)
  }

  const query = await queryResponse.json()
  const synthResponse = await fetch(`${endpoint}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })

  if (!synthResponse.ok) {
    const message = await safeReadText(synthResponse)
    throw new Error(`VOICEVOX synthesis が失敗しました (${synthResponse.status}): ${message}`)
  }

  const buffer = await synthResponse.arrayBuffer()
  return new File([buffer], `voicevox_${Date.now()}.wav`, {
    type: synthResponse.headers.get('content-type') || 'audio/wav',
    lastModified: Date.now(),
  })
}

export const synthesizeVoicevoxCloud = async (text: string, config: VoicevoxCloudRequestConfig): Promise<File> => {
  assertBrowserApis()
  const normalizedText = text.trim()
  if (!normalizedText) throw new Error('読み上げテキストを入力してください')

  const endpoint = normalizeEndpoint(config.endpoint ?? VOICEVOX_CLOUD_ENDPOINT, 'VOICEVOX API エンドポイント')
  const speakerId = Number.isFinite(config.speakerId) ? config.speakerId : 1
  const searchParams = new URLSearchParams({
    text: normalizedText,
    speaker: String(speakerId),
  })

  const response = await fetch(`${endpoint}?${searchParams.toString()}`, { cache: 'no-store' })
  if (!response.ok) {
    const message = await safeReadText(response)
    throw new Error(`VOICEVOX API が失敗しました (${response.status}): ${message}`)
  }
  const result = (await response.json()) as VoicevoxCloudResponse
  if (!result.success) {
    if (typeof result.retryAfter === 'number') {
      throw new Error(`VOICEVOX API が混雑しています。${result.retryAfter} 秒後に再実行してください。`)
    }
    throw new Error('VOICEVOX API が混雑しています。しばらく待ってから再試行してください。')
  }

  const statusUrl = result.audioStatusUrl
  const downloadUrl = result.wavDownloadUrl || result.mp3DownloadUrl || result.mp3StreamingUrl
  if (!statusUrl || !downloadUrl) {
    throw new Error('VOICEVOX API から音声ファイル情報を取得できませんでした')
  }

  await waitForVoicevoxCloudAudio(statusUrl)

  const audioResponse = await fetch(downloadUrl, { cache: 'no-store' })
  if (!audioResponse.ok) {
    const message = await safeReadText(audioResponse)
    throw new Error(`VOICEVOX API 音声のダウンロードに失敗しました (${audioResponse.status}): ${message}`)
  }
  const buffer = await audioResponse.arrayBuffer()
  const contentType =
    audioResponse.headers.get('content-type') || (downloadUrl.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav')
  const extension = downloadUrl.endsWith('.mp3') ? 'mp3' : 'wav'
  return new File([buffer], `voicevox-cloud_${Date.now()}.${extension}`, {
    type: contentType,
    lastModified: Date.now(),
  })
}

interface VoicevoxCloudResponse {
  success: boolean
  retryAfter?: number
  audioStatusUrl?: string
  wavDownloadUrl?: string
  mp3DownloadUrl?: string
  mp3StreamingUrl?: string
}

interface VoicevoxCloudStatusResponse {
  success: boolean
  isAudioReady?: boolean
  isAudioError?: boolean
  status?: string
  retryAfter?: number
}

const waitForVoicevoxCloudAudio = async (statusUrl: string) => {
  const maxAttempts = 90
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusResponse = await fetch(statusUrl, { cache: 'no-store' })
    if (!statusResponse.ok) {
      const message = await safeReadText(statusResponse)
      throw new Error(`VOICEVOX API ステータス確認に失敗しました (${statusResponse.status}): ${message}`)
    }
    const data = (await statusResponse.json()) as VoicevoxCloudStatusResponse
    if (!data.success) {
      throw new Error('VOICEVOX API のステータス取得に失敗しました')
    }
    if (data.isAudioError) {
      throw new Error('VOICEVOX API の音声生成に失敗しました')
    }
    if (data.isAudioReady) {
      return
    }
    const waitMs = Math.min(5000, Math.max(1000, (data.retryAfter ?? 1) * 1000))
    await delay(waitMs)
  }
  throw new Error('VOICEVOX API の生成完了を待てませんでした')
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const safeReadText = async (response: Response) => {
  try {
    return await response.text()
  } catch {
    return 'レスポンス本文を読み取れませんでした'
  }
}
const VOICEVOX_CLOUD_ENDPOINT = 'https://api.tts.quest/v3/voicevox/synthesis'

export interface VoicevoxCloudRequestConfig {
  speakerId: number
  endpoint?: string
}
