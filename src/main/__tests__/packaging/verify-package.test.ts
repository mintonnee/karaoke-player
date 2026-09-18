import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8')

describe('NSIS electron-builder policy', () => {
  it('uses a per-user one-click installer that preserves user data', () => {
    const config = read('electron-builder.nsis.mjs')
    expect(config).toContain("target: [{ target: 'nsis', arch: ['x64'] }]")
    expect(config).toContain('oneClick: true')
    expect(config).toContain('perMachine: false')
    expect(config).toContain('runAfterFinish: false')
    expect(config).toContain('deleteAppDataOnUninstall: false')
    expect(config).toContain('createDesktopShortcut: false')
    expect(config).toContain('createStartMenuShortcut: true')
    expect(config).not.toContain('useZip')
    expect(config).not.toContain('allowElevation')
  })

  it('verifies both the unpacked app and the final embedded installer payload', () => {
    const config = read('electron-builder.nsis.mjs')
    expect(config).toContain("verifyPackagedApp('nsis', context)")
    expect(config).toContain('afterAllArtifactBuild')
    expect(config).toContain('verifyInstaller({')
    expect(config).toContain("process.argv.includes('--dir')")
  })
})

describe('target-isolated runtime staging', () => {
  it('writes schema v2 policy manifests without adding distribution to runtimeId', () => {
    const manifest = read('electron-builder.manifest.mjs')
    expect(manifest).toContain("join(root, 'dist', 'runtime-staging', target)")
    expect(manifest).toContain('schemaVersion: 2')
    expect(manifest).toContain('distribution: target')
    expect(manifest).toContain('capabilities: { ...policy.capabilities }')
    expect(manifest).toContain('toolDelivery: { ...policy.toolDelivery }')
    const runtimeIdBlock = manifest.slice(
      manifest.indexOf('const runtimeId = digestCanonical'),
      manifest.indexOf('const policy = getDistributionPolicy', manifest.indexOf('const runtimeId'))
    )
    expect(runtimeIdBlock).not.toContain('distribution: target')
    expect(runtimeIdBlock).not.toContain('toolDelivery')
  })

  it('selects bundled tools only and keeps NSIS tool-free', () => {
    const manifest = read('electron-builder.manifest.mjs')
    expect(manifest).toContain("if (delivery !== 'bundled') continue")
    expect(manifest).toContain('from: `${staging}/resources/bin/${id}.exe`')
    expect(manifest).toContain("to: 'runtime-manifest.json'")
    expect(manifest).toContain("to: 'locks'")
    expect(manifest).toContain("to: 'sidecar'")
  })

  it('excludes source staging and caches from app.asar', () => {
    const common = read('electron-builder.yml')
    expect(common).toContain("'!resources/bin/**'")
    expect(common).toContain("'!build/**'")
    expect(common).toContain("'!dist/**'")
    expect(common).toContain("'!resources/**/*.zip'")
    expect(common).toContain("'!resources/**/.cache/**'")
  })
})

describe('package commands', () => {
  it('prepares every packaged target explicitly and keeps optionless prepare available', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['prepare:resources']).toBe('node scripts/prepare-resources.mjs')
    expect(pkg.scripts['build:nsis']).toContain('prepare:resources -- --target nsis')
    expect(pkg.scripts['build:unpack:nsis']).toContain('prepare:resources -- --target nsis')
    expect(pkg.scripts['build:zip']).toContain('prepare:resources -- --target zip')
    expect(pkg.scripts['build:msix']).toContain('prepare:resources -- --target appx')
  })
})
