import { join } from 'path'
import { vi } from 'vitest'
import {
  LibraryDbError,
  type LibraryDbErrorCode,
  type LibraryStoreOptions
} from '../../library/LibraryStore'
import type { LibraryStoreHandle } from '../../startup'

export const USER_DATA = join('C:', 'tmp', 'karaoke-user')
export const DB_PATH = join(USER_DATA, 'library.sqlite')

export function makeDbError(
  code: LibraryDbErrorCode,
  init?: {
    message?: string
    discoveredVersion?: number
    backupDir?: string
    dbPath?: string
  }
): LibraryDbError {
  return new LibraryDbError({
    code,
    dbPath: init?.dbPath ?? DB_PATH,
    message: init?.message ?? `${code} 상세`,
    discoveredVersion: init?.discoveredVersion,
    backupDir: init?.backupDir
  })
}

export class FakeLibraryStore implements LibraryStoreHandle {
  static constructed: FakeLibraryStore[] = []
  static lastOptions: LibraryStoreOptions | undefined
  static throwError: unknown = undefined

  readonly dbPath: string
  readonly options: LibraryStoreOptions | undefined
  closed = false
  staleCalls = 0

  constructor(dbPath: string, options?: LibraryStoreOptions) {
    this.dbPath = dbPath
    this.options = options
    FakeLibraryStore.lastOptions = options
    FakeLibraryStore.constructed.push(this)
    if (FakeLibraryStore.throwError !== undefined) {
      throw FakeLibraryStore.throwError
    }
  }

  failStaleSeparating(): number {
    this.staleCalls += 1
    return 0
  }

  close(): void {
    this.closed = true
  }

  static reset(): void {
    FakeLibraryStore.constructed = []
    FakeLibraryStore.lastOptions = undefined
    FakeLibraryStore.throwError = undefined
  }
}

export function mockApp(init?: { lock?: boolean; version?: string; userData?: string }): {
  requestSingleInstanceLock: ReturnType<typeof vi.fn<() => boolean>>
  getVersion: ReturnType<typeof vi.fn<() => string>>
  getPath: ReturnType<typeof vi.fn<(name: string) => string>>
  quit: ReturnType<typeof vi.fn<() => void>>
  exit: ReturnType<typeof vi.fn<(code?: number) => void>>
  on: ReturnType<typeof vi.fn<(event: 'second-instance', listener: () => void) => void>>
  emitSecondInstance: () => void
} {
  const listeners: Array<() => void> = []
  return {
    requestSingleInstanceLock: vi.fn(() => init?.lock ?? true),
    getVersion: vi.fn(() => init?.version ?? '3.2.1'),
    getPath: vi.fn((name: string) => (name === 'userData' ? (init?.userData ?? USER_DATA) : name)),
    quit: vi.fn(() => undefined),
    exit: vi.fn((_code?: number) => undefined),
    on: vi.fn((event: 'second-instance', listener: () => void) => {
      if (event === 'second-instance') listeners.push(listener)
    }),
    emitSecondInstance: (): void => {
      listeners.forEach((listener) => listener())
    }
  }
}

export function mockDialog(responses: number[] = [2]): {
  options: unknown[]
  showMessageBox: ReturnType<typeof vi.fn<(options: unknown) => Promise<{ response: number }>>>
} {
  const options: unknown[] = []
  let index = 0
  return {
    options,
    showMessageBox: vi.fn(async (shown: unknown) => {
      options.push(shown)
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1
      return { response }
    })
  }
}

export function mockShell(): {
  openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
} {
  return {
    openPath: vi.fn(async (_path: string) => '')
  }
}
