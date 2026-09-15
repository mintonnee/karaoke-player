import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const cli = join(repoRoot, 'scripts', 'runtime-lock', 'cli.mjs')

function fixture(names: string[]): string {
  const input = mkdtempSync(join(tmpdir(), 'karaoke-pkg-'))
  mkdirSync(join(input, 'resources', 'bin'), { recursive: true })
  mkdirSync(join(input, 'resources', 'sidecar'), { recursive: true })
  writeFileSync(join(input, 'resources', 'sidecar', 'pyproject.toml'), '')
  writeFileSync(join(input, 'resources', 'sidecar', 'uv.lock'), '')
  for (const name of names) writeFileSync(join(input, 'resources', 'bin', name), 'x')
  return input
}

function runVerifyPackage(target: 'zip' | 'appx', input: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [cli, 'verify-package', '--target', target, '--input', input],
      { encoding: 'utf8', cwd: repoRoot }
    )
    return { ok: true, output }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}` }
  }
}

describe('verify-package fixtures', () => {
  it('ZIP fixture includes yt-dlp', () => {
    const result = runVerifyPackage('zip', fixture(['uv.exe', 'yt-dlp.exe', 'deno.exe']))
    expect(result.ok, result.output).toBe(true)
  })

  it('APPX fixture without yt-dlp is OK', () => {
    const result = runVerifyPackage('appx', fixture(['uv.exe', 'deno.exe']))
    expect(result.ok, result.output).toBe(true)
  })

  it('missing uv.exe fails verify-package', () => {
    const result = runVerifyPackage('zip', fixture(['yt-dlp.exe', 'deno.exe']))
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/uv/)
  })
})

describe('builder extraResources', () => {
  it('zip includes yt-dlp and locks/manifest; appx omits yt-dlp', () => {
    const zip = readFileSync(join(repoRoot, 'electron-builder.zip.mjs'), 'utf8')
    const appx = readFileSync(join(repoRoot, 'electron-builder.msix.mjs'), 'utf8')
    const shared = readFileSync(join(repoRoot, 'electron-builder.manifest.mjs'), 'utf8')
    expect(zip).toContain("extraResourcesFor('zip')")
    expect(appx).toContain("extraResourcesFor('appx')")
    expect(shared).toContain("from: 'resources/bin/yt-dlp.exe'")
    expect(shared).toContain("to: 'bin/yt-dlp.exe'")
    expect(shared).toContain("from: 'build/locks'")
    expect(shared).toContain("to: 'runtime-manifest.json'")
    expect(shared).toMatch(/if \(target === 'zip'\)/)
    expect(shared).not.toContain('uvw.exe')
    expect(shared).not.toContain('uvx.exe')
  })
})
