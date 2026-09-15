import { join } from 'path'
import { isLibraryDbError, type LibraryStoreOptions } from '../library/LibraryStore'
import { presentLibraryDbErrorDialog } from './dialog'
import { ensureSingleInstance } from './singleInstance'
import type {
  LibraryReadyContext,
  LibraryStoreConstructor,
  LibraryStoreHandle,
  StartupApp,
  StartupDialog,
  StartupShell
} from './types'

export interface PrepareLibraryDeps<TStore extends LibraryStoreHandle = LibraryStoreHandle> {
  LibraryStore: LibraryStoreConstructor<TStore>
  dbPath: string
  appVersion: string
  dialog: StartupDialog
  shell: StartupShell
  app: Pick<StartupApp, 'quit' | 'exit'>
}

export interface RunAppStartupDeps<
  TStore extends LibraryStoreHandle = LibraryStoreHandle
> extends Omit<PrepareLibraryDeps<TStore>, 'dbPath' | 'appVersion' | 'app'> {
  app: StartupApp
  joinPath?: (...parts: string[]) => string
  userData?: string
  /** true면 모듈 로드 시점에 이미 잠금을 확보한 것으로 본다 */
  skipSingleInstanceCheck?: boolean
  onSecondInstance?: () => void
  failStaleSeparating: (store: TStore) => number
  recoverIncompletePairImports: (tracksDir: string, store: TStore) => Promise<number>
  recoverIncompleteTrackEdits: (tracksDir: string, store: TStore) => Promise<number>
  registerIpc: (ctx: LibraryReadyContext<TStore>) => void | Promise<void>
  startSidecar: (ctx: LibraryReadyContext<TStore>) => void | Promise<void>
  createWindow?: (ctx: LibraryReadyContext<TStore>) => void
}

export function closeLibraryStore(store: LibraryStoreHandle | undefined): void {
  if (!store) return
  try {
    store.close()
  } catch {
    // 실패 경로에서 핸들이 남지 않게만 한다
  }
}

export function libraryStoreOpenOptions(appVersion: string): LibraryStoreOptions {
  return { appVersion }
}

export async function prepareLibrary<TStore extends LibraryStoreHandle>(
  deps: PrepareLibraryDeps<TStore>
): Promise<TStore | null> {
  let store: TStore | undefined
  try {
    store = new deps.LibraryStore(deps.dbPath, libraryStoreOpenOptions(deps.appVersion))
    return store
  } catch (error) {
    closeLibraryStore(store)
    if (!isLibraryDbError(error)) throw error
    await presentLibraryDbErrorDialog(error, deps)
    return null
  }
}

export async function runAppStartup<TStore extends LibraryStoreHandle>(
  deps: RunAppStartupDeps<TStore>
): Promise<TStore | null> {
  if (!deps.skipSingleInstanceCheck && !ensureSingleInstance(deps.app, deps.onSecondInstance)) {
    return null
  }

  const joinPath = deps.joinPath ?? join
  const userData = deps.userData ?? deps.app.getPath('userData')
  const dbPath = joinPath(userData, 'library.sqlite')
  const tracksDir = joinPath(userData, 'tracks')
  const store = await prepareLibrary({
    LibraryStore: deps.LibraryStore,
    dbPath,
    appVersion: deps.app.getVersion(),
    dialog: deps.dialog,
    shell: deps.shell,
    app: deps.app
  })
  if (!store) return null

  const ctx: LibraryReadyContext<TStore> = { store, userData, dbPath, tracksDir }
  try {
    deps.failStaleSeparating(store)
    await deps.recoverIncompletePairImports(tracksDir, store)
    await deps.recoverIncompleteTrackEdits(tracksDir, store)
    await deps.registerIpc(ctx)
    await deps.startSidecar(ctx)
    deps.createWindow?.(ctx)
    return store
  } catch (error) {
    closeLibraryStore(store)
    throw error
  }
}
