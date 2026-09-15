export {
  LIBRARY_DB_ERROR_CODES,
  LibraryDbError,
  isLibraryDbError,
  type LibraryDbErrorCode,
  type LibraryDbErrorInit
} from './errors'
export {
  SCHEMA_VERSION,
  TRACKS_COLUMNS_BY_VERSION,
  CREATE_V8_TRACKS_SQL,
  readUserVersion,
  listTracksColumns,
  listUserTables,
  columnsMatchVersion
} from './schema'
export {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_LIBRARY_APP_VERSION,
  defaultLibraryBackupDir,
  type LibraryBackupFault,
  type LibraryMigrateFault,
  type LibraryStoreDebugOptions,
  type LibraryStoreOptions
} from './options'
export { restoreLibraryBackup } from './restore'
export { openLibraryDatabase } from './open'
