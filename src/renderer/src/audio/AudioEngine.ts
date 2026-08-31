/**
 * §4.1 AudioEngine 인터페이스 (결정 — 변경 시 반드시 문서 갱신).
 * 렌더러의 어떤 코드도 AudioContext를 직접 만지지 않는다. 오직 구현체 내부에서만 사용한다.
 */

export interface LoopRange {
  start: number
  end: number
}

export type AudioEngineState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export interface AudioEngine {
  /** 파일 경로를 받는다. 버퍼를 넘기지 않는다 (네이티브 엔진 호환). */
  load(tracks: { inst: string; vocal: string }): Promise<void>
  play(): void
  pause(): void
  stop(): void // pause + seek(0)
  seek(seconds: number): void
  setLoop(range: LoopRange | null): void

  setGain(track: 'inst' | 'vocal', db: number): void // -inf 허용 (mute)
  setPitch(semitones: number): void // -6..+6

  /** 엔진이 push하는 유일한 시간 소스. 렌더러는 이 값 + 경과시간으로 보간한다. */
  onPosition(cb: (seconds: number) => void): () => void
  onEnded(cb: () => void): () => void

  readonly duration: number
  readonly state: AudioEngineState
  dispose(): void
}
