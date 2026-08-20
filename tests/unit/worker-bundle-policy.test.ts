import { describe, expect, it } from 'vitest'
import { auditWorkerManifest } from '../../scripts/lib/worker-bundle-policy'

describe('Cloudflare Worker bundle policy', () => {
  it('accepts a Workers-native bundle', () => {
    expect(
      auditWorkerManifest({
        inputs: { 'workers/canary.ts': { imports: [{ path: '<runtime>' }] } },
        outputs: { 'canary.js': { imports: [] } }
      })
    ).toEqual({ inspected: 3, violations: [] })
  })

  it.each(['node:fs', 'node:net', 'node_modules/postgres/index.js', 'sharp/build/Release/sharp.node'])(
    'rejects %s anywhere in the module graph',
    (path) => {
      expect(
        auditWorkerManifest({
          inputs: { 'workers/entry.ts': { imports: [{ path }] } }
        }).violations
      ).toEqual([path])
    }
  )
})
