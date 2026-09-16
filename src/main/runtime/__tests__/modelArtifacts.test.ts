import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactsForModel } from '../modelArtifacts'
import type { LockFile } from '../schema'

const lock = JSON.parse(readFileSync(resolve('build/locks/models.lock.json'), 'utf8')) as LockFile

describe('artifactsForModel', () => {
  it.each(lock.models!)(
    '$id includes every required artifact from the production lock',
    (model) => {
      const selected = artifactsForModel(lock, model.id)
      expect(selected.length).toBeGreaterThan(0)
      expect(selected.map((artifact) => artifact.id)).toEqual(model.artifactIds)
    }
  )

  it('deduplicates shared files across transitive model dependencies', () => {
    const model = lock.models!.find((item) => item.id === 'beat-this-final0')!
    const nested: LockFile = {
      ...lock,
      models: [
        { ...model, id: 'parent', dependsOn: ['child', model.id] },
        { ...model, id: 'child', dependsOn: [model.id] },
        model
      ]
    }
    expect(artifactsForModel(nested, 'parent').map((artifact) => artifact.id)).toEqual([
      'beat-this-final0'
    ])
  })

  it('rejects a missing artifact even when a model with that name exists', () => {
    const broken = { ...lock, artifacts: lock.artifacts.filter((a) => a.id !== 'beat-this-final0') }
    expect(() => artifactsForModel(broken, 'beat-this-final0')).toThrow(
      'unregistered artifact id: beat-this-final0'
    )
  })
})
