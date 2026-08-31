import { MEDIA_PROTOCOL_SCHEME } from '../../../shared/types'
import type { AudioEngine, AudioEngineState, LoopRange } from './AudioEngine'
import { dbToGain, wrapLoopPosition } from './audioMath'

const POSITION_PUSH_INTERVAL_MS = 33 // ~30 Hz (스펙 상한 60 Hz)
const GAIN_RAMP_SEC = 0.01 // 클릭 노이즈 방지용 짧은 램프
const START_DELAY_SEC = 0.03 // 두 소스의 샘플 동기 시작 여유
const PITCH_WORKLET_URL = 'worklets/soundtouch-worklet.js' // renderer public/ 정적 자산
const PITCH_MIN = -6
const PITCH_MAX = 6

function toMediaUrl(path: string): string {
  return `${MEDIA_PROTOCOL_SCHEME}://audio?path=${encodeURIComponent(path)}`
}

interface TrackChannel {
  buffer: AudioBuffer
  gain: GainNode
  source: AudioBufferSourceNode | null
}

/** §4.1 AudioEngine의 v1 Web Audio 구현체. AudioContext는 이 파일 밖에서 사용 금지. */
export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null
  private channels: { inst: TrackChannel; vocal: TrackChannel } | null = null
  private engineState: AudioEngineState = 'idle'
  private trackDuration = 0

  /**
   * 재생 그래프: source → trackGain → mixBus → pitchNode(SoundTouch worklet) → destination.
   * 피치는 인서트 이펙트라 소스/위치 추적에 영향이 없다 (S6 DoD: 키 변경 시 위치 유지).
   */
  private mixBus: GainNode | null = null
  private pitchNode: AudioWorkletNode | null = null
  private pitchGraphReady: Promise<void> | null = null
  private pitchSemitones = 0
  /** 워클릿이 실측 보고하는 파이프라인 지연. 재생 중 위치 보고에서 차감한다. */
  private pitchLatencySec = 0

  /** 정지 시점 위치(초). 재생 중에는 startedAt 기준으로 계산한다. */
  private offset = 0
  private startedAt = 0
  private loop: LoopRange | null = null
  private gainsDb: { inst: number; vocal: number } = { inst: 0, vocal: 0 }

  private readonly positionCallbacks = new Set<(seconds: number) => void>()
  private readonly endedCallbacks = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** stop/seek로 소스를 교체할 때 이전 소스의 onended를 무효화한다 */
  private generation = 0

  get duration(): number {
    return this.trackDuration
  }

  get state(): AudioEngineState {
    return this.engineState
  }

  async load(tracks: { inst: string; vocal: string }): Promise<void> {
    this.stopSources()
    this.stopTimer()
    this.engineState = 'loading'

    const ctx = this.ensureContext()
    try {
      const [instBuffer, vocalBuffer] = await Promise.all([
        this.decodeFile(ctx, tracks.inst),
        this.decodeFile(ctx, tracks.vocal),
        this.ensurePitchGraph(ctx)
      ])
      this.channels = {
        inst: { buffer: instBuffer, gain: this.createGain(ctx, this.gainsDb.inst), source: null },
        vocal: { buffer: vocalBuffer, gain: this.createGain(ctx, this.gainsDb.vocal), source: null }
      }
      this.trackDuration = instBuffer.duration
      this.offset = 0
      this.loop = null
      this.engineState = 'ready'
      this.pushPosition(0)
    } catch (error) {
      this.engineState = 'idle'
      this.channels = null
      this.trackDuration = 0
      throw error
    }
  }

  play(): void {
    if (!this.channels || (this.engineState !== 'ready' && this.engineState !== 'paused')) return
    this.startSources(this.offset)
  }

  pause(): void {
    if (this.engineState !== 'playing') return
    this.offset = this.currentPosition()
    this.stopSources()
    this.stopTimer()
    this.engineState = 'paused'
    this.pushPosition(this.offset)
  }

  stop(): void {
    if (!this.channels) return
    this.stopSources()
    this.stopTimer()
    this.offset = 0
    this.engineState = 'ready'
    this.pushPosition(0)
  }

  seek(seconds: number): void {
    if (!this.channels) return
    const position = Math.max(0, Math.min(seconds, this.trackDuration))
    if (this.engineState === 'playing') {
      this.stopSources()
      this.startSources(position)
    } else {
      this.offset = position
      if (this.engineState === 'ready') this.engineState = 'paused'
      this.pushPosition(position)
    }
  }

  setLoop(range: LoopRange | null): void {
    this.loop = range
    // 네이티브 소스 루프 속성과 경과시간 계산을 일치시키기 위해 재생 중이면 현재 위치에서 재시작
    if (this.engineState === 'playing') {
      const position = this.currentPosition()
      this.stopSources()
      this.startSources(position)
    }
  }

  setGain(track: 'inst' | 'vocal', db: number): void {
    this.gainsDb[track] = db
    const channel = this.channels?.[track]
    const ctx = this.ctx
    if (!channel || !ctx) return
    channel.gain.gain.setTargetAtTime(dbToGain(db), ctx.currentTime, GAIN_RAMP_SEC)
  }

  setPitch(semitones: number): void {
    this.pitchSemitones = Math.max(PITCH_MIN, Math.min(PITCH_MAX, semitones))
    this.pitchNode?.port.postMessage({ pitchSemitones: this.pitchSemitones })
  }

  onPosition(cb: (seconds: number) => void): () => void {
    this.positionCallbacks.add(cb)
    return () => this.positionCallbacks.delete(cb)
  }

  onEnded(cb: () => void): () => void {
    this.endedCallbacks.add(cb)
    return () => this.endedCallbacks.delete(cb)
  }

  dispose(): void {
    this.stopSources()
    this.stopTimer()
    this.positionCallbacks.clear()
    this.endedCallbacks.clear()
    this.channels = null
    this.trackDuration = 0
    this.engineState = 'idle'
    this.pitchNode?.disconnect()
    this.pitchNode = null
    this.mixBus?.disconnect()
    this.mixBus = null
    this.pitchGraphReady = null
    void this.ctx?.close()
    this.ctx = null
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    return this.ctx
  }

  private ensurePitchGraph(ctx: AudioContext): Promise<void> {
    if (!this.pitchGraphReady) {
      this.pitchGraphReady = (async () => {
        await ctx.audioWorklet.addModule(PITCH_WORKLET_URL)
        this.pitchNode = new AudioWorkletNode(ctx, 'soundtouch-processor', {
          channelCount: 2,
          outputChannelCount: [2]
        })
        this.pitchNode.port.onmessage = (event: MessageEvent) => {
          const latency = (event.data as { latencySec?: number } | null)?.latencySec
          if (typeof latency === 'number') this.pitchLatencySec = latency
        }
        this.mixBus = ctx.createGain()
        this.mixBus.connect(this.pitchNode)
        this.pitchNode.connect(ctx.destination)
        if (this.pitchSemitones !== 0) {
          this.pitchNode.port.postMessage({ pitchSemitones: this.pitchSemitones })
        }
      })()
    }
    return this.pitchGraphReady
  }

  private createGain(ctx: AudioContext, db: number): GainNode {
    const gain = ctx.createGain()
    gain.gain.value = dbToGain(db)
    gain.connect(this.mixBus ?? ctx.destination)
    return gain
  }

  private async decodeFile(ctx: AudioContext, path: string): Promise<AudioBuffer> {
    const response = await fetch(toMediaUrl(path))
    if (!response.ok) {
      throw new Error(`failed to read audio file (${response.status}): ${path}`)
    }
    return ctx.decodeAudioData(await response.arrayBuffer())
  }

  private startSources(offset: number): void {
    const ctx = this.ctx
    const channels = this.channels
    if (!ctx || !channels) return

    const generation = ++this.generation
    const when = ctx.currentTime + START_DELAY_SEC

    for (const key of ['inst', 'vocal'] as const) {
      const channel = channels[key]
      const source = ctx.createBufferSource()
      source.buffer = channel.buffer
      if (this.loop) {
        source.loop = true
        source.loopStart = this.loop.start
        source.loopEnd = this.loop.end
      }
      source.connect(channel.gain)
      source.start(when, offset)
      channel.source = source
    }

    // 자연 종료 감지는 inst 소스 기준 (루프 중에는 발생하지 않음)
    channels.inst.source!.onended = () => {
      if (generation !== this.generation) return
      this.handleNaturalEnd()
    }

    this.offset = offset
    this.startedAt = when
    this.engineState = 'playing'
    this.startTimer()
  }

  private stopSources(): void {
    this.generation++
    // 불연속 지점: 워클릿 잔류 오디오를 비우고 정렬을 새로 잡는다
    this.pitchNode?.port.postMessage({ reset: true })
    this.pitchLatencySec = 0
    if (!this.channels) return
    for (const key of ['inst', 'vocal'] as const) {
      const source = this.channels[key].source
      if (!source) continue
      source.onended = null
      try {
        source.stop()
      } catch {
        // 이미 정지된 소스는 무시
      }
      source.disconnect()
      this.channels[key].source = null
    }
  }

  private handleNaturalEnd(): void {
    this.stopSources()
    this.stopTimer()
    this.offset = this.trackDuration
    this.engineState = 'paused'
    this.pushPosition(this.trackDuration)
    this.endedCallbacks.forEach((cb) => cb())
  }

  private currentPosition(): number {
    const ctx = this.ctx
    if (!ctx || this.engineState !== 'playing') return this.offset
    const elapsed = Math.max(0, ctx.currentTime - this.startedAt)
    return Math.min(wrapLoopPosition(this.offset + elapsed, this.loop), this.trackDuration)
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(
      () => this.pushPosition(this.currentPosition()),
      POSITION_PUSH_INTERVAL_MS
    )
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private pushPosition(seconds: number): void {
    const compensated =
      this.engineState === 'playing' ? Math.max(0, seconds - this.pitchLatencySec) : seconds
    this.positionCallbacks.forEach((cb) => cb(compensated))
  }
}
