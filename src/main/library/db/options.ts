import { dirname, join } from 'path'

export type LibraryMigrateFault = 'mid-ddl' | 'data-conversion' | 'version-write'
export type LibraryBackupFault = 'write' | 'verify'

/** 테스트 전용. 프로덕션 D2는 사용하지 않는다. */
export interface LibraryStoreDebugOptions {
  migrateFault?: LibraryMigrateFault
  backupFault?: LibraryBackupFault
}

export interface LibraryStoreOptions {
  /** 생략 시 `<dirname(dbPath)>/backups/db` */
  backupDir?: string
  /** 백업 메타에 기록. 생략 시 `0.1.0` */
  appVersion?: string
  /** SQLite busy 대기. 기본 5000ms (스펙 최대 5초) */
  busyTimeoutMs?: number
  debug?: LibraryStoreDebugOptions
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000
export const DEFAULT_LIBRARY_APP_VERSION = '0.1.0'

export function defaultLibraryBackupDir(dbPath: string): string {
  return join(dirname(dbPath), 'backups', 'db')
}

export function resolveLibraryAppVersion(options?: LibraryStoreOptions): string {
  return options?.appVersion ?? process.env.npm_package_version ?? DEFAULT_LIBRARY_APP_VERSION
}

export function resolveBusyTimeoutMs(options?: LibraryStoreOptions): number {
  const value = options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(value) || value < 0) return DEFAULT_BUSY_TIMEOUT_MS
  return value
}
