import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { COVER_FILE_NAME, COVER_NONE_MARKER, sanitizeTrackMetaPatch } from '../../shared/trackEdit'
import type { TrackCoverAction, TrackMetaPatch } from '../../shared/trackEdit'
import { inspectCoverImage } from './coverImage'

export const TRACK_EDIT_JOURNAL = 'track-edit.json'
export const COVER_BACKUP = 'cover.jpg.bak'
export const COVER_NONE_BACKUP = 'cover.none.bak'
export const COVER_STAGING = 'cover.jpg.staging'
export const COVER_EXTRACT_TMP = 'cover.extract.tmp'

export interface TrackEditJournal {
  version: 1
  trackId: string
  cover: 'replace' | 'remove'
  filesApplied: boolean
  patch: TrackMetaPatch
  hadCover: boolean
  hadNone: boolean
  createdAt: string
}

export interface TrackEditStore {
  getTrack(id: string): { id: string } | undefined
  applyMetaPatch(id: string, patch: TrackMetaPatch): unknown
}

/**
 * 앱 시작 시 미완료 곡 수정 파일 작업을 정리한다 (스펙 005 §4.3).
 * filesApplied면 새 파일을 유지하고 메타 패치를 재적용한다. 아니면 백업을 되돌린다.
 * DB에 없는 곡은 재생성하지 않고 임시 산출물만 지운다.
 */
export async function recoverIncompleteTrackEdits(
  tracksDir: string,
  store: TrackEditStore
): Promise<number> {
  if (!existsSync(tracksDir)) return 0

  let cleaned = 0
  const entries = await readdir(tracksDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(tracksDir, entry.name)
    if (existsSync(join(dir, TRACK_EDIT_JOURNAL))) {
      const journal = await readJournal(dir)
      const track = journal ? store.getTrack(journal.trackId) : undefined
      if (!journal || !track) {
        await cleanupTemps(dir)
        cleaned += 1
        continue
      }
      if (journal.filesApplied) {
        store.applyMetaPatch(journal.trackId, journal.patch)
        await finalizeTrackEditFiles(dir)
      } else {
        await rollbackTrackEditFiles(dir, journal)
        await cleanupTemps(dir)
      }
      cleaned += 1
      continue
    }
    if (await cleanupOrphanTemps(dir)) cleaned += 1
  }
  return cleaned
}

export async function beginCoverEdit(
  dir: string,
  trackId: string,
  cover: Extract<TrackCoverAction, { type: 'replace' | 'remove' }>,
  patch: TrackMetaPatch
): Promise<TrackEditJournal> {
  await mkdir(dir, { recursive: true })
  const coverPath = join(dir, COVER_FILE_NAME)
  const nonePath = join(dir, COVER_NONE_MARKER)
  const journal: TrackEditJournal = {
    version: 1,
    trackId,
    cover: cover.type,
    filesApplied: false,
    patch,
    hadCover: existsSync(coverPath),
    hadNone: existsSync(nonePath),
    createdAt: new Date().toISOString()
  }
  await writeJournal(dir, journal)
  if (journal.hadCover) await copyFile(coverPath, join(dir, COVER_BACKUP))
  if (journal.hadNone) await copyFile(nonePath, join(dir, COVER_NONE_BACKUP))
  return journal
}

export async function installCoverAction(
  dir: string,
  cover: Extract<TrackCoverAction, { type: 'replace' | 'remove' }>
): Promise<void> {
  const coverPath = join(dir, COVER_FILE_NAME)
  const nonePath = join(dir, COVER_NONE_MARKER)
  const staging = join(dir, COVER_STAGING)
  if (cover.type === 'replace') {
    const inspected = await inspectCoverImage(cover.path)
    if (!inspected.ok) throw new Error(inspected.message)
    await copyFile(cover.path, staging)
    await rm(coverPath, { force: true })
    await rename(staging, coverPath)
    await rm(nonePath, { force: true })
    return
  }
  await rm(coverPath, { force: true })
  await rm(staging, { force: true })
  await writeFile(nonePath, '', 'utf-8')
}

export async function markCoverFilesApplied(dir: string, journal: TrackEditJournal): Promise<void> {
  await writeJournal(dir, { ...journal, filesApplied: true })
}

export async function finalizeTrackEditFiles(dir: string): Promise<void> {
  await cleanupTemps(dir)
}

export async function rollbackTrackEditFiles(
  dir: string,
  journal: TrackEditJournal
): Promise<void> {
  const coverPath = join(dir, COVER_FILE_NAME)
  const nonePath = join(dir, COVER_NONE_MARKER)
  const coverBak = join(dir, COVER_BACKUP)
  const noneBak = join(dir, COVER_NONE_BACKUP)
  await rm(join(dir, COVER_STAGING), { force: true })

  if (existsSync(coverBak)) {
    await rm(coverPath, { force: true })
    await rename(coverBak, coverPath)
  } else if (!journal.hadCover) {
    await rm(coverPath, { force: true })
  }

  if (existsSync(noneBak)) {
    await rm(nonePath, { force: true })
    await rename(noneBak, nonePath)
  } else if (!journal.hadNone) {
    await rm(nonePath, { force: true })
  }
}

async function writeJournal(dir: string, journal: TrackEditJournal): Promise<void> {
  const target = join(dir, TRACK_EDIT_JOURNAL)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(journal), 'utf-8')
  await rm(target, { force: true })
  await rename(tmp, target)
}

async function readJournal(dir: string): Promise<TrackEditJournal | null> {
  const path = join(dir, TRACK_EDIT_JOURNAL)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return parseJournal(raw)
  } catch {
    return null
  }
}

function parseJournal(raw: unknown): TrackEditJournal | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (rec.version !== 1 || typeof rec.trackId !== 'string' || rec.trackId === '') return null
  if (rec.cover !== 'replace' && rec.cover !== 'remove') return null
  if (typeof rec.filesApplied !== 'boolean') return null
  if (typeof rec.hadCover !== 'boolean' || typeof rec.hadNone !== 'boolean') return null
  if (typeof rec.createdAt !== 'string') return null
  try {
    return {
      version: 1,
      trackId: rec.trackId,
      cover: rec.cover,
      filesApplied: rec.filesApplied,
      patch: sanitizeTrackMetaPatch(rec.patch ?? {}),
      hadCover: rec.hadCover,
      hadNone: rec.hadNone,
      createdAt: rec.createdAt
    }
  } catch {
    return null
  }
}

async function cleanupTemps(dir: string): Promise<void> {
  await rm(join(dir, TRACK_EDIT_JOURNAL), { force: true })
  await rm(join(dir, `${TRACK_EDIT_JOURNAL}.tmp`), { force: true })
  await rm(join(dir, COVER_BACKUP), { force: true })
  await rm(join(dir, COVER_NONE_BACKUP), { force: true })
  await rm(join(dir, COVER_STAGING), { force: true })
  await rm(join(dir, COVER_EXTRACT_TMP), { force: true })
}

async function cleanupOrphanTemps(dir: string): Promise<boolean> {
  const leftovers = [
    join(dir, `${TRACK_EDIT_JOURNAL}.tmp`),
    join(dir, COVER_STAGING),
    join(dir, COVER_EXTRACT_TMP)
  ]
  let removed = false
  for (const path of leftovers) {
    if (!existsSync(path)) continue
    await rm(path, { force: true })
    removed = true
  }
  return removed
}
