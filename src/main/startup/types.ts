import type { LibraryStoreOptions } from '../library/LibraryStore'

export interface LibraryStoreHandle {
  failStaleSeparating(): number
  close(): void
}

export type LibraryStoreConstructor<TStore extends LibraryStoreHandle = LibraryStoreHandle> = new (
  dbPath: string,
  options?: LibraryStoreOptions
) => TStore

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  exit?(code?: number): void
  on(event: 'second-instance', listener: () => void): unknown
}

export interface StartupApp extends SingleInstanceApp {
  getVersion(): string
  getPath(name: string): string
}

export interface StartupDialog {
  showMessageBox(options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning'
    title?: string
    message: string
    detail?: string
    buttons: string[]
    defaultId?: number
    cancelId?: number
    noLink?: boolean
  }): Promise<{ response: number }>
}

export interface StartupShell {
  openPath(path: string): Promise<string>
}

export interface LibraryReadyContext<TStore extends LibraryStoreHandle = LibraryStoreHandle> {
  store: TStore
  userData: string
  dbPath: string
  tracksDir: string
}
