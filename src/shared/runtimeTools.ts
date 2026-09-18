export const TOOL_IDS = Object.freeze(['uv', 'deno', 'yt-dlp'] as const)

export type ToolId = (typeof TOOL_IDS)[number]

export const TOOL_READINESS_STATUSES = Object.freeze([
  'pending',
  'downloading',
  'verifying',
  'ready',
  'error',
  'disabled'
] as const)

export type ToolReadinessStatus = (typeof TOOL_READINESS_STATUSES)[number]

/** 배포 도구 하나의 현재 준비 상태. Python bootstrap 상태와 별도로 관리한다. */
export interface ToolReadinessState {
  toolId: ToolId
  status: ToolReadinessStatus
  downloadedBytes: number | null
  totalBytes: number | null
  error: string | null
  retryable: boolean
}

/** 렌더러 진입 시 조회하는 전체 도구 준비 상태. 이후 이벤트는 도구 하나씩 갱신한다. */
export interface ToolReadinessSnapshot {
  tools: Record<ToolId, ToolReadinessState>
}

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value)
}

export function isToolReady(
  snapshot: ToolReadinessSnapshot | null | undefined,
  toolId: ToolId
): boolean {
  return snapshot?.tools[toolId].status === 'ready'
}
