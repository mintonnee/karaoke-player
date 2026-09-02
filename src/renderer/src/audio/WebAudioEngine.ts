import { MEDIA_PROTOCOL_SCHEME } from '../../../shared/types'
import type { AudioEngine, AudioEngineState, AudioLevels, LoopRange } from './AudioEngine'
import { dbToGain, rmsDb, wrapLoopPosition } from './audioMath'

const POSITION_PUSH_INTERVAL_MS = 33 // ~30 Hz (스펙 상한 60 Hz)
const GAIN_RAMP_SEC = 0.01 // 클릭 노이즈 방지용 짧은 램프
const START_DELAY_SEC = 0.03 // 두 소스의 샘플 동기 시작 여유
/* 시크 전환 예약 여유. 라이브 소스가 liveAt에 정확히 시작해야 프리롤과 이어지므로, 메인 스레드 지연으로
 * start(when)이 과거가 되는 일이 없게 재생 시작보다 넉넉히 잡는다 (늦게 시작하면 그만큼 구간이 반복된다). */
const SEEK_DELAY_SEC = 0.06
const SOURCE_FADE_SEC = 0.01 // 소스 교체(시크·일시정지·루프 변경) 시 클릭 방지 엔벌로프
const SEEK_PRE_MARGIN_FRAMES = 128 // 프리롤 앞 여유: 워클릿 전환 블록이 liveAt보다 최대 한 블록 앞선다
const SEEK_POST_MARGIN_SEC = 0.1 // 프리롤 뒤 여유: 메시지가 liveAt보다 늦게 닿아도 이어 붙인다
const DEFAULT_PRIME_FRAMES = 7168 // 워클릿이 시작 시 실제 PRIME_FRAMES를 보고한다
const PITCH_WORKLET_URL = 'worklets/soundtouch-worklet.js' // renderer public/ 정적 자산
const PITCH_MIN = -6
const PITCH_MAX = 6
const METER_FFT_SIZE = 256 // 레벨 탭 analyser 창 크기
const METER_FLOOR_DB = -60

function toMediaUrl(path: string): string {
  return `${MEDIA_PROTOCOL_SCHEME}://audio?path=${encodeURIComponent(path)}`
}

interface TrackChannel {
  buffer: AudioBuffer
  gain: GainNode
  /** 게인 뒤 옆가지 탭. 재생 경로에는 연결하지 않는다 (post-fader 미터) */
  analyser: AnalyserNode
  source: AudioBufferSourceNode | null
  /** 소스별 페이드 인/아웃 엔벌로프. source → envelope → gain */
  envelope: GainNode | null
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
  /** 워클릿 프라이밍 프레임 수. 시크 프리롤 길이로 쓴다 */
  private primeFrames = DEFAULT_PRIME_FRAMES

  /** 정지 시점 위치(초). 재생 중에는 startedAt 기준으로 계산한다. */
  private offset = 0
  private startedAt = 0
  private loop: LoopRange | null = null
  private gainsDb: { inst: number; vocal: number } = { inst: 0, vocal: 0 }

  private readonly positionCallbacks = new Set<(seconds: number) => void>()
  private readonly endedCallbacks = new Set<() => void>()
  private readonly levelCallbacks = new Set<(levels: AudioLevels) => void>()
  /** 피치 노드 뒤 옆가지 탭 (실제 출력 레벨) */
  private masterAnalyser: AnalyserNode | null = null
  /** 틱마다 재할당하지 않기 위한 공용 버퍼 */
  private readonly levelBuffer = new Float32Array(METER_FFT_SIZE)
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
    this.releaseChannels()
    this.pushSilentLevels()
    this.engineState = 'loading'

    const ctx = this.ensureContext()
    try {
      const [instBuffer, vocalBuffer] = await Promise.all([
        this.decodeFile(ctx, tracks.inst),
        this.decodeFile(ctx, tracks.vocal),
        this.ensurePitchGraph(ctx)
      ])
      this.channels = {
        inst: this.createChannel(ctx, instBuffer, this.gainsDb.inst),
        vocal: this.createChannel(ctx, vocalBuffer, this.gainsDb.vocal)
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
    this.pushSilentLevels()
  }

  stop(): void {
    if (!this.channels) return
    this.stopSources()
    this.stopTimer()
    this.offset = 0
    this.engineState = 'ready'
    this.pushPosition(0)
    this.pushSilentLevels()
  }

  seek(seconds: number): void {
    if (!this.channels) return
    const position = Math.max(0, Math.min(seconds, this.trackDuration))
    if (this.engineState === 'playing') {
      this.seekPlaying(position)
    } else {
      this.offset = position
      if (this.engineState === 'ready') this.engineState = 'paused'
      this.pushPosition(position)
    }
  }

  setLoop(range: LoopRange | null): void {
    const previous = this.loop
    this.loop = range
    // 네이티브 소스 루프 속성과 경과시간 계산을 일치시키기 위해 재생 중이면 지금 들리는 위치에서 재시작
    if (this.engineState === 'playing' && this.ctx) {
      const liveAt = this.ctx.currentTime + SEEK_DELAY_SEC
      this.seekPlaying(this.audibleContentAt(liveAt, previous), liveAt)
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

  onLevels(cb: (levels: AudioLevels) => void): () => void {
    this.levelCallbacks.add(cb)
    return () => this.levelCallbacks.delete(cb)
  }

  dispose(): void {
    this.stopSources()
    this.stopTimer()
    this.pushSilentLevels()
    this.positionCallbacks.clear()
    this.endedCallbacks.clear()
    this.levelCallbacks.clear()
    this.releaseChannels()
    this.trackDuration = 0
    this.engineState = 'idle'
    this.masterAnalyser?.disconnect()
    this.masterAnalyser = null
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
          const data = event.data as { latencySec?: number; primeFrames?: number } | null
          if (typeof data?.latencySec === 'number') this.pitchLatencySec = data.latencySec
          if (typeof data?.primeFrames === 'number') this.primeFrames = data.primeFrames
        }
        this.mixBus = ctx.createGain()
        this.mixBus.connect(this.pitchNode)
        this.pitchNode.connect(ctx.destination)
        // 실제 출력 레벨 탭 (옆가지, 어디에도 연결하지 않는다)
        this.masterAnalyser = this.createAnalyser(ctx)
        this.pitchNode.connect(this.masterAnalyser)
        if (this.pitchSemitones !== 0) {
          this.pitchNode.port.postMessage({ pitchSemitones: this.pitchSemitones })
        }
      })()
    }
    return this.pitchGraphReady
  }

  private createChannel(ctx: AudioContext, buffer: AudioBuffer, db: number): TrackChannel {
    const gain = this.createGain(ctx, db)
    return { buffer, gain, analyser: this.tapAnalyser(ctx, gain), source: null, envelope: null }
  }

  private createGain(ctx: AudioContext, db: number): GainNode {
    const gain = ctx.createGain()
    gain.gain.value = dbToGain(db)
    gain.connect(this.mixBus ?? ctx.destination)
    return gain
  }

  /** 게인 뒤 옆가지 탭. 재생 경로(gain → mixBus)는 그대로 둔다. */
  private tapAnalyser(ctx: AudioContext, gain: GainNode): AnalyserNode {
    const analyser = this.createAnalyser(ctx)
    gain.connect(analyser)
    return analyser
  }

  private createAnalyser(ctx: AudioContext): AnalyserNode {
    const analyser = ctx.createAnalyser()
    analyser.fftSize = METER_FFT_SIZE
    return analyser
  }

  /** 이전 곡의 게인·analyser를 그래프에서 끊는다. 끊지 않으면 곡을 바꿀 때마다 mixBus에 노드가 누적된다. */
  private releaseChannels(): void {
    if (!this.channels) return
    for (const key of ['inst', 'vocal'] as const) {
      this.channels[key].gain.disconnect()
      this.channels[key].analyser.disconnect()
    }
    this.channels = null
  }

  private async decodeFile(ctx: AudioContext, path: string): Promise<AudioBuffer> {
    const response = await fetch(toMediaUrl(path))
    if (!response.ok) {
      throw new Error(`failed to read audio file (${response.status}): ${path}`)
    }
    return ctx.decodeAudioData(await response.arrayBuffer())
  }

  /** 시각 t에 들리고 있을 콘텐츠 위치 = 소스 위치 − 파이프라인 지연 */
  private audibleContentAt(t: number, loop: LoopRange | null): number {
    const elapsed = Math.max(0, t - this.startedAt)
    return Math.max(0, wrapLoopPosition(this.offset + elapsed, loop) - this.pitchLatencySec)
  }

  /**
   * 재생 중 위치 이동 (클릭·구멍·반복 없는 시크).
   * 워클릿에 남은 이전 위치 오디오는 버린다(그대로 두면 시크 직전 구간이 한 번 더 들린다). 대신 새 위치의
   * 첫 primeFrames를 미리 섞어 만든 프리롤을 보내 워클릿이 liveAt에 파이프라인을 새로 만들자마자 채우게 하고,
   * 라이브 소스는 프리롤이 끝나는 콘텐츠 위치에서 정확히 liveAt에 시작해 이어 붙는다. 워클릿 쪽 정렬은
   * soundtouch-worklet.js `_switchToSeek` 참고.
   */
  private seekPlaying(content: number, liveAt?: number): void {
    const ctx = this.ctx
    const channels = this.channels
    const port = this.pitchNode?.port
    if (!ctx || !channels) return
    const at = liveAt ?? ctx.currentTime + SEEK_DELAY_SEC
    const sr = ctx.sampleRate
    const margin = SEEK_PRE_MARGIN_FRAMES
    const prime = this.primeFrames
    const total = margin + prime + Math.round(SEEK_POST_MARGIN_SEC * sr)
    const startFrame = Math.round(content * sr) - margin
    const liveOffset = (startFrame + margin + prime) / sr
    const prerollEnd = (startFrame + total) / sr
    // 프리롤 구간이 곡 끝이나 루프 끝을 넘으면 선형 프리롤과 소스 재생이 어긋난다 → 비우고 페이드로 재시작
    const crossesLoopEnd =
      this.loop !== null && content < this.loop.end && prerollEnd > this.loop.end
    if (!port || liveOffset >= this.trackDuration || crossesLoopEnd) {
      this.stopSources()
      this.startSources(content, at)
      return
    }

    // 현재 게인(뮤트 포함)을 적용한 두 스템의 합 = 워클릿이 실제로 받는 입력
    const left = new Float32Array(total)
    const right = new Float32Array(total)
    for (const key of ['inst', 'vocal'] as const) {
      const gain = dbToGain(this.gainsDb[key])
      if (gain === 0) continue
      const buffer = channels[key].buffer
      const cl = buffer.getChannelData(0)
      const cr = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : cl
      const from = Math.max(0, -startFrame)
      const to = Math.min(total, buffer.length - startFrame)
      for (let i = from; i < to; i++) {
        left[i] += cl[startFrame + i] * gain
        right[i] += cr[startFrame + i] * gain
      }
    }

    this.stopSources({ flush: false }) // 이전 소스는 지금 페이드 아웃, 워클릿 전환은 liveAt에
    port.postMessage(
      { seek: { left, right, liveAt: at, marginFrames: margin, primeFrames: prime } },
      [left.buffer, right.buffer]
    )
    this.pitchLatencySec = prime / sr // 전환 직후 지연. 워클릿이 실측값을 곧바로 다시 보고한다
    this.startSources(liveOffset, at, false)
  }

  private startSources(offset: number, at?: number, fadeIn = true): void {
    const ctx = this.ctx
    const channels = this.channels
    if (!ctx || !channels) return

    const generation = ++this.generation
    const when = at ?? ctx.currentTime + START_DELAY_SEC

    for (const key of ['inst', 'vocal'] as const) {
      const channel = channels[key]
      const source = ctx.createBufferSource()
      source.buffer = channel.buffer
      if (this.loop) {
        source.loop = true
        source.loopStart = this.loop.start
        source.loopEnd = this.loop.end
      }
      // 파형 중간에서 시작하는 스텝 불연속을 없애기 위해 짧은 페이드 인을 끼운다
      const envelope = ctx.createGain()
      if (fadeIn) {
        envelope.gain.setValueAtTime(0, when)
        envelope.gain.linearRampToValueAtTime(1, when + SOURCE_FADE_SEC)
      }
      source.connect(envelope)
      envelope.connect(channel.gain)
      source.start(when, offset)
      channel.source = source
      channel.envelope = envelope
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

  /**
   * 소스를 페이드 아웃 뒤 멈춘다. `at`은 페이드 시작 시각(기본 지금).
   * `flush`면 워클릿 잔류 오디오를 비우고 정렬을 새로 잡는다(정지·일시정지·언로드). 시크는 비우지 않는다.
   */
  private stopSources(options: { at?: number; flush?: boolean } = {}): void {
    this.generation++
    if (options.flush ?? true) {
      this.pitchNode?.port.postMessage({ reset: true })
      this.pitchLatencySec = 0
    }
    if (!this.channels) return
    for (const key of ['inst', 'vocal'] as const) {
      const channel = this.channels[key]
      const source = channel.source
      const envelope = channel.envelope
      if (!source) continue
      channel.source = null
      channel.envelope = null
      const detach = (): void => {
        source.disconnect()
        envelope?.disconnect()
      }
      // 페이드 아웃 뒤에 멈추고, 실제로 끝난 뒤 그래프에서 뗀다 (즉시 disconnect하면 하드 컷)
      source.onended = detach
      const at = options.at ?? this.ctx?.currentTime ?? 0
      try {
        if (envelope) {
          // 미래 시각의 현재값을 붙들고 거기서 0으로 램프 (페이드 인 도중 시크해도 연속)
          envelope.gain.cancelAndHoldAtTime(at)
          envelope.gain.linearRampToValueAtTime(0, at + SOURCE_FADE_SEC)
        }
        source.stop(at + SOURCE_FADE_SEC)
      } catch {
        // 이미 정지된 소스는 바로 뗀다
        detach()
      }
    }
  }

  private handleNaturalEnd(): void {
    this.stopSources()
    this.stopTimer()
    this.offset = this.trackDuration
    this.engineState = 'paused'
    this.pushPosition(this.trackDuration)
    this.pushSilentLevels()
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
    this.timer = setInterval(() => {
      this.pushPosition(this.currentPosition())
      this.pushLevels()
    }, POSITION_PUSH_INTERVAL_MS)
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

  /** 구독자가 없으면 analyser를 읽지 않는다. */
  private pushLevels(): void {
    if (this.levelCallbacks.size === 0) return
    const levels: AudioLevels = {
      inst: this.readLevel(this.channels?.inst.analyser ?? null),
      vocal: this.readLevel(this.channels?.vocal.analyser ?? null),
      master: this.readLevel(this.masterAnalyser)
    }
    this.levelCallbacks.forEach((cb) => cb(levels))
  }

  private readLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return METER_FLOOR_DB
    analyser.getFloatTimeDomainData(this.levelBuffer)
    return rmsDb(this.levelBuffer, METER_FLOOR_DB)
  }

  /** 정지·일시정지·언로드 시 미터를 내리는 마지막 push */
  private pushSilentLevels(): void {
    if (this.levelCallbacks.size === 0) return
    const levels: AudioLevels = {
      inst: METER_FLOOR_DB,
      vocal: METER_FLOOR_DB,
      master: METER_FLOOR_DB
    }
    this.levelCallbacks.forEach((cb) => cb(levels))
  }
}
