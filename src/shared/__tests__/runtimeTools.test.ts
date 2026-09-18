import { describe, expect, it } from 'vitest'
import { isToolId, isToolReady, type ToolReadinessSnapshot } from '../runtimeTools'
import { IPC_CHANNELS } from '../types'

function snapshot(): ToolReadinessSnapshot {
  return {
    tools: {
      uv: {
        toolId: 'uv',
        status: 'ready',
        downloadedBytes: null,
        totalBytes: null,
        error: null,
        retryable: false
      },
      deno: {
        toolId: 'deno',
        status: 'pending',
        downloadedBytes: null,
        totalBytes: null,
        error: null,
        retryable: false
      },
      'yt-dlp': {
        toolId: 'yt-dlp',
        status: 'disabled',
        downloadedBytes: null,
        totalBytes: null,
        error: null,
        retryable: false
      }
    }
  }
}

describe('runtime tool readiness contract', () => {
  it('고정된 도구 ID만 수락한다', () => {
    expect(isToolId('uv')).toBe(true)
    expect(isToolId('deno')).toBe(true)
    expect(isToolId('yt-dlp')).toBe(true)
    expect(isToolId('python')).toBe(false)
  })

  it('ready만 실행 가능한 상태로 본다', () => {
    const state = snapshot()
    expect(isToolReady(state, 'uv')).toBe(true)
    expect(isToolReady(state, 'deno')).toBe(false)
    expect(isToolReady(state, 'yt-dlp')).toBe(false)
  })

  it('snapshot·retry·state IPC 채널을 고정한다', () => {
    expect(IPC_CHANNELS.toolReadinessGet).toBe('runtime-tools:get')
    expect(IPC_CHANNELS.toolReadinessRetry).toBe('runtime-tools:retry')
    expect(IPC_CHANNELS.toolReadinessState).toBe('runtime-tools:state')
  })
})
