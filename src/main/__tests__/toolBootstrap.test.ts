import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, type BootstrapState } from '../../shared/types'
import type { ToolReadinessSnapshot } from '../../shared/runtimeTools'
import { registerIpcHandlers, type IpcDeps } from '../ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  app: { getVersion: () => 'test' },
  dialog: {},
  shell: {},
  nativeImage: {}
}))

function snapshot(ready: boolean): ToolReadinessSnapshot {
  return {
    tools: Object.fromEntries(
      ['uv', 'deno', 'yt-dlp'].map((toolId) => [
        toolId,
        {
          toolId,
          status: ready ? 'ready' : 'pending',
          downloadedBytes: null,
          totalBytes: null,
          error: null,
          retryable: false
        }
      ])
    ) as ToolReadinessSnapshot['tools']
  }
}

describe('tool readiness IPC and late URL service availability', () => {
  beforeEach(() => handlers.clear())

  function setup(supported = true): {
    preview: ReturnType<typeof vi.fn>
    importUrl: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
    readyPython: () => void
  } {
    let tools = snapshot(false)
    let python: BootstrapState = {
      status: 'error',
      message: 'Python not ready',
      error: 'offline',
      log: []
    }
    const preview = vi.fn(async () => ({ status: 'ready', code: 'READY' }))
    const importUrl = vi.fn(async () => ({ imported: [], rejected: [] }))
    let available = false
    const retry = vi.fn(async () => {
      tools = snapshot(true)
      available = true
      return tools
    })
    const services = (): unknown => ({
      ytDlpService: available ? { importUrl } : null,
      previewService: available
        ? {
            preview,
            abortActive: vi.fn(),
            cancel: vi.fn(),
            confirmReadyForImport: vi.fn(async () => ({ ok: true }))
          }
        : null
    })
    registerIpcHandlers({
      store: {},
      importService: {},
      lyricsService: {},
      searchKeyService: {},
      settingsStore: {},
      tracksDir: '',
      notify: vi.fn(),
      capabilities: { urlImport: supported },
      ytDlpService: null,
      previewService: null,
      trackEditService: {},
      coverService: {},
      analysisService: {},
      getBootstrapState: () => python,
      getToolReadiness: () => tools,
      retryToolReadiness: retry,
      getUrlServices: services
    } as unknown as IpcDeps)
    return {
      preview,
      importUrl,
      retry,
      readyPython: () => {
        python = { status: 'ready', message: '', error: null, log: [] }
      }
    }
  }

  const event = { sender: { id: 1 } }
  const request = { requestId: 'test:1', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }

  it('지원 capability는 유지하고 도구 재시도 후 서비스를 재시작 없이 조회한다', async () => {
    const mocks = setup()
    expect(await handlers.get(IPC_CHANNELS.previewYoutube)!(event, request)).toMatchObject({
      code: 'TOOLS_NOT_READY'
    })
    expect(mocks.preview).not.toHaveBeenCalled()
    await handlers.get(IPC_CHANNELS.toolReadinessRetry)!(event, 'deno')
    expect(await handlers.get(IPC_CHANNELS.previewYoutube)!(event, request)).toMatchObject({
      code: 'READY'
    })
    expect(mocks.preview).toHaveBeenCalledTimes(1)
    // Python 실패 상태에서는 미리보기만 가능하고 실제 가져오기는 거부한다.
    expect(await handlers.get(IPC_CHANNELS.importUrl)!(event, request.url)).toMatchObject({
      imported: [],
      rejected: [expect.anything()]
    })
    expect(mocks.importUrl).not.toHaveBeenCalled()
    mocks.readyPython()
    await handlers.get(IPC_CHANNELS.importUrl)!(event, request.url)
    expect(mocks.importUrl).toHaveBeenCalledTimes(1)
  })

  it('APPX는 캐시에 도구와 서비스가 있어도 미리보기·가져오기를 거부한다', async () => {
    const mocks = setup(false)
    await handlers.get(IPC_CHANNELS.toolReadinessRetry)!(event, 'deno')
    mocks.readyPython()
    expect(await handlers.get(IPC_CHANNELS.previewYoutube)!(event, request)).toMatchObject({
      code: 'DISABLED'
    })
    await handlers.get(IPC_CHANNELS.importUrl)!(event, request.url)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.importUrl).not.toHaveBeenCalled()
  })

  it('임의 도구 ID는 재시도에 전달하지 않는다', () => {
    const mocks = setup()
    expect(() => handlers.get(IPC_CHANNELS.toolReadinessRetry)!(event, '../../uv')).toThrow()
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(handlers.get(IPC_CHANNELS.toolReadinessGet)!(event)).toEqual(snapshot(false))
  })
})
