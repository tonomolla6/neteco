import { describe, expect, it } from 'vitest'
import { originalWorkerSources } from '../../scripts/lib/worker-source-map'

describe('original Worker source-map evidence', () => {
  it('retains ordinary Rollup sources and deduplicates without reading source content', () => {
    expect(
      originalWorkerSources({
        version: 3,
        sources: ['../../app/app.vue', '../../app/app.vue', '../../workers/shop.ts'],
        sourcesContent: ['unused secret-like fixture text']
      })
    ).toEqual(['../../app/app.vue', '../../workers/shop.ts'])
  })

  it('retains a package hidden in sourceRoot', () => {
    expect(originalWorkerSources({ version: 3, sourceRoot: '../node_modules/pg', sources: ['lib/client.js'] })).toEqual(
      ['../node_modules/pg/lib/client.js']
    )
  })

  it('normalizes Windows separators without losing the package root', () => {
    expect(
      originalWorkerSources({ version: 3, sourceRoot: '..\\node_modules\\redis\\', sources: ['lib\\index.js'] })
    ).toEqual(['../node_modules/redis/lib/index.js'])
  })

  it('retains rooted builtins without overriding absolute source identities', () => {
    expect(
      originalWorkerSources({
        version: 3,
        sourceRoot: 'node:fs',
        sources: ['promises', '/node_modules/sharp/lib/index.js', 'node:crypto']
      })
    ).toEqual(['node:fs/promises', '/node_modules/sharp/lib/index.js', 'node:crypto'])
  })

  it('supports inline indexed maps with each section owning its root', () => {
    expect(
      originalWorkerSources({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: { version: 3, sourceRoot: 'node:net', sources: ['index.js'] } },
          { offset: { line: 1, column: 0 }, map: { version: 3, sources: ['../../workers/shop.ts'] } }
        ]
      })
    ).toEqual(['node:net/index.js', '../../workers/shop.ts'])
  })

  it('allows an individual empty standard map, not a fabricated source entry', () => {
    expect(originalWorkerSources({ version: 3, sources: [] })).toEqual([])
  })

  it.each([
    null,
    {},
    { version: 2, sources: ['worker.ts'] },
    { version: 3, sources: 'worker.ts' },
    { version: 3, sources: [''] },
    { version: 3, sources: [null] },
    { version: 3, sources: ['worker\u0000.ts'] },
    { version: 3, sourceRoot: null, sources: ['worker.ts'] },
    { version: 3, sourceRoot: 'node:fs\n', sources: ['index.js'] },
    { version: 3, sections: [] },
    { version: 3, sections: [{ offset: { line: 0, column: 0 }, url: 'https://example.invalid/map' }] },
    { version: 3, sections: [{ offset: { line: -1, column: 0 }, map: { version: 3, sources: ['worker.ts'] } }] },
    { version: 3, sources: [], sections: [] }
  ])('rejects corrupt or external evidence %#', (input) => {
    expect(() => originalWorkerSources(input)).toThrow('invalid_worker_source_map_evidence')
  })

  it('bounds nested indexed-map recursion', () => {
    let map: Record<string, unknown> = { version: 3, sources: ['worker.ts'] }
    for (let index = 0; index < 20; index++) {
      map = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map }] }
    }
    expect(() => originalWorkerSources(map)).toThrow('invalid_worker_source_map_evidence')
  })
})
