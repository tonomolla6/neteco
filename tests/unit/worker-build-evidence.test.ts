import { describe, expect, it } from 'vitest'
import { auditWorkerManifest, type WorkerBundleManifest } from '../../scripts/lib/worker-bundle-policy'
import { originalWorkerSources } from '../../scripts/lib/worker-source-map'

function manifest(): WorkerBundleManifest {
  return {
    inputs: { 'workers/shop.ts': { bytes: 10, imports: [] } },
    outputs: {
      'shop.js': {
        bytes: 10,
        imports: [],
        exports: ['default'],
        entryPoint: 'workers/shop.ts',
        inputs: { 'workers/shop.ts': { bytesInOutput: 10 } }
      }
    }
  }
}

describe('combined Worker build evidence', () => {
  it('checks the original graph without mutating it or fabricating source-map input records', () => {
    const graph = manifest()
    const snapshot = structuredClone(graph)
    const sources = originalWorkerSources({ version: 3, sources: ['../../workers/runtime/shop-ingress.ts'] })
    expect(auditWorkerManifest(graph, sources).violations).toEqual([])
    expect(graph).toEqual(snapshot)
    expect(Object.keys(graph.inputs)).toEqual(['workers/shop.ts'])
  })

  it.each(['pg', 'redis', 'nodemailer', 'sharp'])('rejects %s hidden in a standard map sourceRoot', (name) => {
    const sources = originalWorkerSources({
      version: 3,
      sourceRoot: `../node_modules/${name}`,
      sources: ['lib/index.js']
    })
    expect(auditWorkerManifest(manifest(), sources).violations).toEqual([`../node_modules/${name}/lib/index.js`])
  })

  it.each(['fs', 'net', 'tls', 'child_process'])('rejects node:%s hidden in an inline indexed map root', (name) => {
    const sources = originalWorkerSources({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sourceRoot: `node:${name}`, sources: ['index.js'] } }
      ]
    })
    expect(auditWorkerManifest(manifest(), sources).violations).toEqual([`node:${name}/index.js`])
  })

  it('does not let valid source-map evidence repair missing esbuild inputs/outputs', () => {
    const sources = originalWorkerSources({ version: 3, sources: ['workers/shop.ts'] })
    const result = auditWorkerManifest({}, sources)
    expect(result.inspected).toBeGreaterThan(0)
    expect(result.violations).toEqual(expect.arrayContaining(['invalid_manifest:inputs', 'invalid_manifest:outputs']))
  })

  it('does not let valid maps conceal a corrupt graph input record', () => {
    const graph = { ...manifest(), inputs: { 'workers/shop.ts': {} } }
    const sources = originalWorkerSources({ version: 3, sources: ['workers/shop.ts'] })
    expect(auditWorkerManifest(graph, sources).violations).toEqual(
      expect.arrayContaining([
        'invalid_manifest:inputs["workers/shop.ts"].bytes',
        'invalid_manifest:inputs["workers/shop.ts"].imports'
      ])
    )
  })

  it('preserves supported Node compatibility builtins and local files that are not package imports', () => {
    const sources = originalWorkerSources({
      version: 3,
      sources: ['node:crypto', 'node:async_hooks', 'node:buffer', '../app/utils/redis.ts', '../app/utils/fs/index.ts']
    })
    expect(auditWorkerManifest(manifest(), sources).violations).toEqual([])
  })

  it.each(['#neteco/nitro-renderer', 'commonjs-external:#neteco/nitro-renderer', '#renderer?commonjs-external'])(
    'retains actual Wrangler private import aliases in original evidence: %s',
    (original) => {
      const graph = manifest()
      graph.inputs['renderer.mjs'] = { bytes: 10, imports: [] }
      graph.inputs['workers/shop.ts']!.imports.push({ path: 'renderer.mjs', kind: 'import-statement', original })
      expect(auditWorkerManifest(graph).violations).toEqual([])
    }
  )

  it('still blocks a private alias when its resolved target is a forbidden builtin', () => {
    const graph = manifest()
    graph.inputs['workers/shop.ts']!.imports.push({
      path: 'node:fs',
      kind: 'import-statement',
      external: true,
      original: '#renderer'
    })
    expect(auditWorkerManifest(graph).violations).toContain('node:fs')
  })
})
