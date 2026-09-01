import { readFileSync, writeFileSync } from 'fs'
import type { AppSettings } from '../../shared/types'

/**
 * <userData>/settings.json 기반 앱 설정.
 * 프로세스 수명 동안 메모리에 캐시하고 변경 시 즉시 파일에 반영한다.
 * env(KARAOKE_DEMUCS_MODEL)는 파일에 값이 없을 때의 기본값으로만 쓰인다.
 */
export class SettingsStore {
  private settings: AppSettings

  constructor(private readonly filePath: string) {
    this.settings = { ...this.defaults(), ...this.load() }
  }

  private defaults(): AppSettings {
    return { demucsModel: process.env.KARAOKE_DEMUCS_MODEL ?? 'htdemucs_ft' }
  }

  private load(): Partial<AppSettings> {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<AppSettings>
    } catch {
      return {}
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch }
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8')
    return this.get()
  }
}
