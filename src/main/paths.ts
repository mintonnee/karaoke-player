import { app } from 'electron'
import { join } from 'path'

/**
 * 번들 리소스 경로 규약 (스펙 001 §4.1·§4.2).
 * - 패키징: <resourcesPath>/bin/*.exe, <resourcesPath>/sidecar/
 * - dev: <appPath>/resources/bin/ (gitignore 대상, 없을 수 있음), <appPath>/sidecar/
 */
export interface BundledPathsContext {
  isPackaged: boolean
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getAppPath() */
  appPath: string
  /** process.platform. 기본은 현재 프로세스 */
  platform?: NodeJS.Platform
}

export function resolveBundledBinDir(ctx: BundledPathsContext): string {
  return ctx.isPackaged ? join(ctx.resourcesPath, 'bin') : join(ctx.appPath, 'resources', 'bin')
}

export function resolveBundledSidecarDir(ctx: BundledPathsContext): string {
  return ctx.isPackaged ? join(ctx.resourcesPath, 'sidecar') : join(ctx.appPath, 'sidecar')
}

/** name은 'uv' 또는 'uv.exe' 둘 다 허용. 확장자가 없으면 win32에서 .exe를 붙인다 */
export function resolveBundledBinary(ctx: BundledPathsContext, name: string): string {
  const platform = ctx.platform ?? process.platform
  const fileName = platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name) ? `${name}.exe` : name
  return join(resolveBundledBinDir(ctx), fileName)
}

function electronContext(): BundledPathsContext {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  }
}

export function getBundledBinDir(): string {
  return resolveBundledBinDir(electronContext())
}

export function getBundledSidecarDir(): string {
  return resolveBundledSidecarDir(electronContext())
}

export function getBundledBinary(name: string): string {
  return resolveBundledBinary(electronContext(), name)
}
