/**
 * §4.1 AudioEngine 인터페이스 (결정 — 변경 시 반드시 문서 갱신).
 * 렌더러의 어떤 코드도 AudioContext를 직접 만지지 않는다. 오직 구현체 내부에서만 사용한다.
 */

export interface LoopRange {
  start: number
  end: number
}

export type AudioEngineState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

/** 재생 레벨 (dBFS RMS, -60..0). 미터 표시 전용. */
export interface AudioLevels {
  inst: number // dBFS RMS, -60-0. 트랙 게인 뒤(post-fader)
  vocal: number
  master: number // 피치 노드 출력(실제 출력)
}

export interface AudioEngine {
  /** 디스크 경로. `guide`는 vocal.wav(vocal_only) 또는 guide.wav(full_mix). 보컬 전용이라고 가정하지 않는다. */
  load(tracks: { inst: string; guide: string | null }): Promise<void>
  play(): void
  pause(): void
  stop(): void // 로드 중이면 취소하고 idle, 그 외에는 pause + seek(0)
  seek(seconds: number): void
  setLoop(range: LoopRange | null): void

  /** vocal = 가이드 채널(vocal_only 보컬 / full_mix AR). -inf 허용 (mute) */
  setGain(track: 'inst' | 'vocal', db: number): void
  setPitch(semitones: number): void // -6..+6

  /** 엔진이 push하는 유일한 시간 소스. 렌더러는 이 값 + 경과시간으로 보간한다. */
  onPosition(cb: (seconds: number) => void): () => void
  onEnded(cb: () => void): () => void
  /** 위치 push와 같은 틱(≤60 Hz)에 push. 정지·일시정지·언로드 시 -60을 한 번 push한다. */
  onLevels(cb: (levels: AudioLevels) => void): () => void

  readonly duration: number
  readonly state: AudioEngineState
  dispose(): void
}
