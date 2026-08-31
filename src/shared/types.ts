/** §4.2 probe 결과. 사이드카 done.result와 1:1 대응 */
export interface ProbeResult {
  duration: number
  sample_rate: number
  channels: number
  title?: string
  artist?: string
  album?: string
}

/** 렌더러 → 메인 probe 요청 응답 */
export interface PickAndProbeResponse {
  canceled: boolean
  filePath?: string
  result?: ProbeResult
  error?: string
}

export const IPC_CHANNELS = {
  pickAndProbe: 'probe:pick-and-probe'
} as const
