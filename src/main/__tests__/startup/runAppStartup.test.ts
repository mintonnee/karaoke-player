import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIBRARY_DB_ERROR_CODES, type LibraryStoreOptions } from '../../library/LibraryStore'
import {
  LIBRARY_DB_DIALOG_QUIT_ID,
  ensureSingleInstance,
  prepareLibrary,
  runAppStartup
} from '../../startup'
import type { RunAppStartupDeps } from '../../startup'
import {
  DB_PATH,
  FakeLibraryStore,
  USER_DATA,
  makeDbError,
  mockApp,
  mockDialog,
  mockShell
} from './helpers'

function hookSpies(): Pick<
  RunAppStartupDeps<FakeLibraryStore>,
  | 'failStaleSeparating'
  | 'recoverIncompletePairImports'
  | 'recoverIncompleteTrackEdits'
  | 'registerIpc'
  | 'startSidecar'
  | 'createWindow'
> {
  return {
    failStaleSeparating: vi.fn((store) => store.failStaleSeparating()),
    recoverIncompletePairImports: vi.fn(async () => 0),
    recoverIncompleteTrackEdits: vi.fn(async () => 0),
    registerIpc: vi.fn(),
    startSidecar: vi.fn(),
    createWindow: vi.fn()
  }
}

function startupDeps(
  app: ReturnType<typeof mockApp> = mockApp()
): RunAppStartupDeps<FakeLibraryStore> & {
  app: ReturnType<typeof mockApp>
  dialog: ReturnType<typeof mockDialog>
  shell: ReturnType<typeof mockShell>
} {
  const hooks = hookSpies()
  const dialog = mockDialog([LIBRARY_DB_DIALOG_QUIT_ID])
  const shell = mockShell()
  return {
    app,
    dialog,
    shell,
    LibraryStore: FakeLibraryStore,
    ...hooks
  }
}

afterEach(() => {
  FakeLibraryStore.reset()
})

describe('ensureSingleInstance (criterion 7)', () => {
  it('잠금을 얻지 못하면 종료하고 두 번째 인스턴스 핸들러를 등록하지 않는다', () => {
    const app = mockApp({ lock: false })
    const onSecond = vi.fn()
    expect(ensureSingleInstance(app, onSecond)).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.on).not.toHaveBeenCalled()
    expect(onSecond).not.toHaveBeenCalled()
  })

  it('잠금을 얻으면 second-instance 콜백을 등록한다', () => {
    const app = mockApp({ lock: true })
    const onSecond = vi.fn()
    expect(ensureSingleInstance(app, onSecond)).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()
    app.emitSecondInstance()
    expect(onSecond).toHaveBeenCalledTimes(1)
  })
})

describe('runAppStartup', () => {
  it('성공 시 appVersion을 넘기고 복구·IPC·sidecar·창을 실행한다', async () => {
    const deps = startupDeps(mockApp({ version: '4.5.6' }))
    const store = await runAppStartup(deps)
    expect(store).toBeInstanceOf(FakeLibraryStore)
    expect(FakeLibraryStore.constructed).toHaveLength(1)
    expect(FakeLibraryStore.lastOptions).toEqual({
      appVersion: '4.5.6'
    } satisfies LibraryStoreOptions)
    expect(FakeLibraryStore.lastOptions).not.toHaveProperty('debug')
    expect(FakeLibraryStore.constructed[0].dbPath).toBe(DB_PATH)
    expect(deps.failStaleSeparating).toHaveBeenCalledTimes(1)
    expect(deps.recoverIncompletePairImports).toHaveBeenCalledWith(join(USER_DATA, 'tracks'), store)
    expect(deps.recoverIncompleteTrackEdits).toHaveBeenCalledWith(join(USER_DATA, 'tracks'), store)
    expect(deps.registerIpc).toHaveBeenCalledTimes(1)
    expect(deps.startSidecar).toHaveBeenCalledTimes(1)
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
    expect(store?.closed).toBe(false)
    expect(store?.staleCalls).toBe(1)
    expect(deps.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it.each([...LIBRARY_DB_ERROR_CODES])(
    '%s 이면 복구·sidecar·IPC를 호출하지 않고 핸들을 남기지 않는다',
    async (code) => {
      FakeLibraryStore.throwError = makeDbError(code, {
        discoveredVersion: 11,
        message:
          code === 'DB_MIGRATION_FAILED'
            ? '라이브러리 DB 업그레이드에 실패했습니다. 원본은 롤백되어 보존되었습니다.'
            : `${code} 실패`
      })
      const deps = startupDeps()
      const store = await runAppStartup(deps)
      expect(store).toBeNull()
      expect(deps.failStaleSeparating).not.toHaveBeenCalled()
      expect(deps.recoverIncompletePairImports).not.toHaveBeenCalled()
      expect(deps.recoverIncompleteTrackEdits).not.toHaveBeenCalled()
      expect(deps.registerIpc).not.toHaveBeenCalled()
      expect(deps.startSidecar).not.toHaveBeenCalled()
      expect(deps.createWindow).not.toHaveBeenCalled()
      expect(deps.dialog.showMessageBox).toHaveBeenCalledTimes(1)
      expect(deps.app.quit).toHaveBeenCalled()
      expect(FakeLibraryStore.lastOptions).toEqual({ appVersion: '3.2.1' })
    }
  )

  it('LibraryDbError 이후 오케스트레이터는 store를 보유하지 않는다', async () => {
    FakeLibraryStore.throwError = makeDbError('DB_SCHEMA_TOO_NEW', { discoveredVersion: 99 })
    const deps = startupDeps()
    const store = await runAppStartup(deps)
    expect(store).toBeNull()
    expect(deps.createWindow).not.toHaveBeenCalled()
    expect(deps.startSidecar).not.toHaveBeenCalled()
  })

  it('성공 후 훅이 실패하면 열린 store를 close 한다', async () => {
    const deps = startupDeps()
    deps.failStaleSeparating = vi.fn(() => {
      throw new Error('stale failed')
    })
    await expect(runAppStartup(deps)).rejects.toThrow('stale failed')
    expect(FakeLibraryStore.constructed).toHaveLength(1)
    expect(FakeLibraryStore.constructed[0].closed).toBe(true)
    expect(deps.registerIpc).not.toHaveBeenCalled()
    expect(deps.startSidecar).not.toHaveBeenCalled()
    expect(deps.createWindow).not.toHaveBeenCalled()
  })

  it('requestSingleInstanceLock() === false 이면 LibraryStore를 만들지 않고 종료한다', async () => {
    const deps = startupDeps(mockApp({ lock: false }))
    const store = await runAppStartup(deps)
    expect(store).toBeNull()
    expect(FakeLibraryStore.constructed).toHaveLength(0)
    expect(FakeLibraryStore.lastOptions).toBeUndefined()
    expect(deps.app.quit).toHaveBeenCalledTimes(1)
    expect(deps.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(deps.failStaleSeparating).not.toHaveBeenCalled()
    expect(deps.recoverIncompletePairImports).not.toHaveBeenCalled()
    expect(deps.recoverIncompleteTrackEdits).not.toHaveBeenCalled()
    expect(deps.registerIpc).not.toHaveBeenCalled()
    expect(deps.startSidecar).not.toHaveBeenCalled()
    expect(deps.createWindow).not.toHaveBeenCalled()
  })

  it('LibraryDbError가 아닌 개방 오류는 삼키지 않고 복구도 시작하지 않는다', async () => {
    FakeLibraryStore.throwError = new Error('EACCES disk')
    const deps = startupDeps()
    await expect(runAppStartup(deps)).rejects.toThrow('EACCES disk')
    expect(deps.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(deps.failStaleSeparating).not.toHaveBeenCalled()
    expect(deps.startSidecar).not.toHaveBeenCalled()
    expect(deps.registerIpc).not.toHaveBeenCalled()
    expect(deps.createWindow).not.toHaveBeenCalled()
  })
})

describe('prepareLibrary leftover handle', () => {
  it('생성자 실패 시 store를 반환하지 않고 복구를 시작하지 않는다', async () => {
    const app = mockApp()
    const dialog = mockDialog([LIBRARY_DB_DIALOG_QUIT_ID])
    const shell = mockShell()
    FakeLibraryStore.throwError = makeDbError('DB_BUSY')
    const result = await prepareLibrary({
      LibraryStore: FakeLibraryStore,
      dbPath: DB_PATH,
      appVersion: '1.0.0',
      dialog,
      shell,
      app
    })
    expect(result).toBeNull()
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(app.quit).toHaveBeenCalled()
  })
})
