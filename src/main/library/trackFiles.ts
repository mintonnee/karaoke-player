import { existsSync } from 'fs'
import { join } from 'path'
import { guideAudioFileName } from '../../shared/types'
import type { Track, TrackFiles } from '../../shared/types'

export function resolveTrackFiles(tracksDir: string, track: Track): TrackFiles {
  const inst = join(tracksDir, track.id, 'inst.wav')
  const guideName = guideAudioFileName(track.guideKind)
  const guide = guideName === null ? null : join(tracksDir, track.id, guideName)
  return { inst, guide, vocal: guide, guideKind: track.guideKind }
}

/** ready여도 필수 파일이 없으면 재생을 거부한다 (스펙 004 §4.5) */
export function requireReadyTrackFiles(tracksDir: string, track: Track): TrackFiles {
  if (track.status !== 'ready') {
    throw new Error(`track not ready: ${track.id} (${track.status})`)
  }
  const files = resolveTrackFiles(tracksDir, track)
  if (!existsSync(files.inst) || (files.guide !== null && !existsSync(files.guide))) {
    throw new Error(`required files missing for track ${track.id}`)
  }
  return files
}
