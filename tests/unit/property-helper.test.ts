import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkProperty } from '../support/property'

const failureFile = resolve(process.cwd(), 'test-results/property-failures/property-helper-failure.json')

describe('property test helper', () => {
  it('runs a deterministic property with 200 cases by default', async () => {
    const property = fc.property(fc.integer(), (value) => Number.isInteger(value))
    const first = await checkProperty('property-helper-default', property)
    const second = await checkProperty('property-helper-default', property)

    expect(first).toMatchObject({ failed: false, numRuns: 200 })
    expect(second).toMatchObject({ failed: false, numRuns: 200, seed: first.seed })
  })

  it('persists a safe counterexample and throws a replayable error', async () => {
    await rm(failureFile, { force: true })
    const property = fc.property(fc.constant('counterexample'), () => false)

    try {
      await expect(checkProperty('property-helper-failure', property, { numRuns: 5 })).rejects.toThrow(
        'Property "property-helper-failure" failed'
      )
      const evidence = JSON.parse(await readFile(failureFile, 'utf8')) as Record<string, unknown>
      expect(evidence).toMatchObject({
        id: 'property-helper-failure',
        seed: expect.any(Number),
        counterexamplePath: expect.any(String),
        numShrinks: expect.any(Number),
        counterexample: ['counterexample']
      })
    } finally {
      await rm(failureFile, { force: true })
    }
  })
})
