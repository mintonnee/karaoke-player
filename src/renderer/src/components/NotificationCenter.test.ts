import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolId, ToolReadinessSnapshot } from '../../../shared/runtimeTools'
import type { BootstrapState } from '../../../shared/types'
import type { AppErrorEntry } from '../stores/errorStore'

function bootstrap(patch: Partial<BootstrapState> = {}): BootstrapState {
  return { status: 'checking', message: '확인 중', error: null, log: [], ...patch }
}

function toolSnapshot(
  patch: Partial<Record<ToolId, Partial<ToolReadinessSnapshot['tools'][ToolId]>>> = {}
): ToolReadinessSnapshot {
  const state = (toolId: ToolId): ToolReadinessSnapshot['tools'][ToolId] => ({
    toolId,
    status: 'ready',
    downloadedBytes: null,
    totalBytes: null,
    error: null,
    retryable: false,
    ...patch[toolId]
  })
  return { tools: { uv: state('uv'), deno: state('deno'), 'yt-dlp': state('yt-dlp') } }
}

function readyToolProps(): {
  toolSnapshot: ToolReadinessSnapshot
  toolsLoaded: boolean
  toolLoadError: null
  toolRetrying: Record<ToolId, boolean>
  toolRetryErrors: Record<ToolId, string | null>
  onToolRetry: (toolId: ToolId) => void
} {
  return {
    toolSnapshot: toolSnapshot(),
    toolsLoaded: true,
    toolLoadError: null,
    toolRetrying: { uv: false, deno: false, 'yt-dlp': false },
    toolRetryErrors: { uv: null, deno: null, 'yt-dlp': null },
    onToolRetry: vi.fn<(toolId: ToolId) => void>()
  }
}

describe('notification center rendering', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      api: {
        onAppError: vi.fn(() => () => {}),
        getAppInfo: vi.fn(),
        openExternal: vi.fn(),
        retryBootstrap: vi.fn()
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('ready이고 오류가 없으면 알림 빈 상태를 표시한다', async () => {
    const { NotificationCenter } = await import('./ErrorCenter')

    const html = renderToStaticMarkup(
      React.createElement(NotificationCenter, {
        ...readyToolProps(),
        onClose: vi.fn(),
        entries: [],
        state: bootstrap({ status: 'ready', message: '준비 완료' }),
        retrying: false,
        retryError: null,
        remove: vi.fn(),
        clear: vi.fn(),
        onRetry: vi.fn()
      })
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-labelledby="notification-center-title"')
    expect(html).toContain('새로운 알림이 없습니다.')
    expect(html).not.toContain('오류 기록')
  })

  it('모델 준비를 단계 상태로 표시하고 기술 정보는 details 안에 둔다', async () => {
    const { NotificationCenter } = await import('./ErrorCenter')
    const state = bootstrap({
      status: 'model-prep',
      stage: 'model-prep',
      logicalId: 'beat-this-final0',
      message: '모델 캐시 확인 중',
      log: ['cache/path']
    })

    const html = renderToStaticMarkup(
      React.createElement(NotificationCenter, {
        ...readyToolProps(),
        onClose: vi.fn(),
        entries: [],
        state,
        retrying: false,
        retryError: null,
        remove: vi.fn(),
        clear: vi.fn(),
        onRetry: vi.fn()
      })
    )
    expect(html).toContain('모델 준비 중')
    expect(html).toContain('<details')
    expect(html).toContain('id=beat-this-final0')
    expect(html).not.toContain('작업 완료')
    expect(html).not.toContain('다시 시도</button>')
  })

  it('strict retryable runtime 실패에만 재시도를 표시하고 오류 동작은 별도 영역에 둔다', async () => {
    const { NotificationCenter } = await import('./ErrorCenter')
    const entry: AppErrorEntry = {
      id: 'e1',
      source: 'player',
      message: 'C:/Users/example/song.wav 재생 실패',
      at: '2026-09-17T00:00:00.000Z',
      seen: false
    }

    const html = renderToStaticMarkup(
      React.createElement(NotificationCenter, {
        ...readyToolProps(),
        onClose: vi.fn(),
        entries: [entry],
        state: bootstrap({
          status: 'error',
          stage: 'env-prep',
          error: '환경 구성 실패',
          retryable: true
        }),
        retrying: false,
        retryError: null,
        remove: vi.fn(),
        clear: vi.fn(),
        onRetry: vi.fn()
      })
    )
    expect(html).toContain('환경 구성 실패')
    expect(html).toContain('>다시 시도</button>')
    expect(html).toContain('오류 기록')
    expect(html).toContain('전체 보고')
    expect(html).toContain('title="지우기"')
  })

  it('오류 50건과 긴 메시지를 하나의 내부 오류 목록에 렌더링한다', async () => {
    const { NotificationCenter } = await import('./ErrorCenter')
    const longMessage = `긴 오류 ${'경로/세부정보/'.repeat(30)}`
    const entries: AppErrorEntry[] = Array.from({ length: 50 }, (_, index) => ({
      id: `e${index}`,
      source: 'jobs',
      message: index === 0 ? longMessage : `오류 ${index}`,
      at: '2026-09-17T00:00:00.000Z',
      seen: true
    }))

    const html = renderToStaticMarkup(
      React.createElement(NotificationCenter, {
        ...readyToolProps(),
        onClose: vi.fn(),
        entries,
        state: bootstrap({ status: 'ready', message: '준비 완료' }),
        retrying: false,
        retryError: null,
        remove: vi.fn(),
        clear: vi.fn(),
        onRetry: vi.fn()
      })
    )
    expect(html.match(/class="error-item"/g)).toHaveLength(50)
    expect(html).toContain(longMessage)
    expect(html.match(/class="error-list"/g)).toHaveLength(1)
  })

  it('도구별 진행률과 실패 단계, 실행 가능한 재시도를 표시한다', async () => {
    const { NotificationCenter } = await import('./ErrorCenter')
    const onToolRetry = vi.fn<(toolId: ToolId) => void>()
    const html = renderToStaticMarkup(
      React.createElement(NotificationCenter, {
        ...readyToolProps(),
        onClose: vi.fn(),
        entries: [],
        state: bootstrap({ status: 'ready', message: '준비 완료' }),
        retrying: false,
        retryError: null,
        toolSnapshot: toolSnapshot({
          deno: {
            status: 'downloading',
            downloadedBytes: 1024,
            totalBytes: 2048
          },
          'yt-dlp': {
            status: 'error',
            error: 'HTTP 429',
            retryable: true
          }
        }),
        toolRetrying: { uv: false, deno: false, 'yt-dlp': false },
        onToolRetry,
        remove: vi.fn(),
        clear: vi.fn(),
        onRetry: vi.fn()
      })
    )

    expect(html).toContain('도구 준비 상태')
    expect(html).toContain('1.0 KB / 2.0 KB')
    expect(html).toContain('yt-dlp')
    expect(html).toContain('stage=error')
    expect(html).toContain('HTTP 429')
    expect(html).toContain('>다시 시도</button>')
  })
})
