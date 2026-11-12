import { describe, expect, it } from 'vitest'
import { auditWorkerManifest, type WorkerBundleManifest } from '../../scripts/lib/worker-bundle-policy'
import { testNow } from '../support/deterministic'

// The installed esbuild Metafile contract, including optional Node-compatible imports.
function validManifest(): WorkerBundleManifest {
  return {
    inputs: { 'workers/entry.ts': { bytes: 100, imports: [], format: 'esm' } },
    outputs: {
      'entry.js': {
        bytes: 80,
        imports: [],
        exports: ['default'],
        entryPoint: 'workers/entry.ts',
        inputs: { 'workers/entry.ts': { bytesInOutput: 60 } }
      }
    }
  }
}

function manifestImport(path: string) {
  const manifest = validManifest()
  manifest.inputs['workers/entry.ts']!.imports.push({ path, kind: 'import-statement', external: true })
  return manifest
}

const forbiddenPaths = [
  'exceljs',
  'exceljs/dist/exceljs.min.js',
  'node_modules/exceljs/excel.js',
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'webpack://node:fs/promises',
  '/workspace/node:tls/index.js',
  'C:\\workspace\\node:child_process\\index.js',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'child_process',
  'node:child_process',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'http2',
  'node:http2',
  'pg',
  'pg/lib/client.js',
  'pg-native',
  'pg-pool',
  'pg-protocol',
  'pg-connection-string',
  'pg-types',
  'pgpass',
  'pg-cursor',
  'pg-query-stream',
  'postgres',
  'postgres-array',
  'postgres-bytea',
  'postgres-date',
  'postgres-interval',
  'redis',
  'redis/index.js',
  'ioredis',
  'redis-parser',
  'redis-commands',
  '@redis/client',
  '@redis/json/dist/index.js',
  '@ioredis/commands',
  'nodemailer',
  'nodemailer/lib/smtp-connection/index.js',
  'smtp-connection',
  'smtp-server',
  'smtp-client',
  'emailjs',
  'emailjs-smtp-client',
  'sharp',
  'sharp/build/Release/sharp.node',
  '@img/sharp-linux-x64',
  '@img/sharp-libvips-linux-x64/lib/index.js',
  'bindings',
  'node-gyp-build',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'ffi-napi',
  'ref-napi',
  'node_modules/postgres/index.js',
  '../node_modules/pg/lib/client.js',
  '/workspace/node_modules/redis/dist/index.js',
  'C:\\workspace\\node_modules\\@redis\\client\\dist\\index.js',
  'node_modules/.pnpm/pg@8.0.0/node_modules/pg/lib/client.js',
  '../../node_modules/pg@8.0.0/lib/client.js',
  'node_modules/@redis/client@5.0.0/index.js',
  'node_modules/./pg/lib/client.js',
  'node_modules/allowed/../pg/lib/client.js',
  'file:///workspace/node_modules/sharp/lib/index.js',
  'npm:pg@8.0.0/lib/client.js',
  'npm:@redis/client@5.0.0/dist/index.js',
  'node:fs?commonjs-external',
  'node:tls#external',
  '\0node:child_process?commonjs-external',
  'external:fs/promises',
  'external:node:tls?commonjs-external',
  'commonjs-external:redis',
  'node-external:node:net',
  '__vite-browser-external:node:fs',
  '\0external:commonjs-external:node:fs?commonjs-proxy',
  'fs\\promises?commonjs-external',
  'node:fs\\promises#external',
  'node_modules\\ioredis\\built\\Redis.js?commonjs-proxy',
  './native/binding.node',
  'binding.NODE?commonjs-external',
  '/lib/native.so',
  '/lib/native.so.1.2?external',
  'C:\\native\\binding.node#external',
  '/lib/native.dylib',
  '/lib/native.dll',
  'tests/support/media-runtime.ts',
  '/workspace/tests/support/media-runtime.ts',
  'tests\\support\\media-runtime.ts',
  '../../tests/support/media-runtime.ts?commonjs-proxy'
]

describe('Cloudflare Worker bundle policy', () => {
  it('accepts a Workers-native bundle', () => {
    expect(auditWorkerManifest(manifestImport('<runtime>'))).toEqual({ inspected: 5, violations: [] })
  })

  it.each(forbiddenPaths)('rejects %s in imports', (path) => {
    expect(auditWorkerManifest(manifestImport(path)).violations).toEqual([path])
  })

  it.each([
    'input key',
    'output key',
    'input import',
    'original import',
    'output import',
    'attribution',
    'entry point',
    'css bundle'
  ])('inspects the %s independently', (position) => {
    const manifest = validManifest()
    const path = 'node_modules/sharp/native.so'
    const input = manifest.inputs['workers/entry.ts']!
    const output = manifest.outputs['entry.js']!
    if (position === 'input key') manifest.inputs[path] = { bytes: 10, imports: [] }
    else if (position === 'output key') manifest.outputs[path] = { ...output }
    else if (position === 'input import') input.imports.push({ path, kind: 'require-call' })
    else if (position === 'original import') {
      input.imports.push({ path: 'workers/compat.ts', original: path, kind: 'import-statement' })
    } else if (position === 'output import') output.imports.push({ path, kind: 'dynamic-import', external: true })
    else if (position === 'attribution') output.inputs[path] = { bytesInOutput: 10 }
    else if (position === 'entry point') {
      manifest.inputs[path] = { bytes: 10, imports: [] }
      output.entryPoint = path
    } else {
      manifest.outputs[path] = { ...output }
      output.cssBundle = path
    }
    expect(auditWorkerManifest(manifest).violations).toContain(path)
  })

  it.each([
    'async_hooks',
    'node:async_hooks',
    'buffer',
    'node:buffer',
    'crypto',
    'node:crypto',
    'events',
    'node:events',
    'node:util',
    'node:path',
    'node:stream',
    'node:stream/promises',
    'node:url',
    'node:assert/strict',
    'cloudflare:workers',
    'cloudflare:sockets',
    'node:async_hooks?commonjs-external',
    '\0external:node:crypto#external',
    '\0external:\0node:crypto',
    'external:buffer',
    './fs',
    './fs/promises.ts',
    'src/fs.ts',
    'src/tls-client.ts',
    'src/child_process.test.ts',
    'src/redis.ts',
    'src/redis/index.ts',
    'src/pg/index.ts',
    'src/postgres-migration.ts',
    'src/nodemailer-receipt.ts',
    'src/sharp-image.ts',
    'src/native.node.ts',
    'src/native.so.json',
    'src/node:fs.ts',
    'src/external:tls.ts',
    'tests/supporting.ts',
    'test/support/runtime.ts',
    'node_modules/pg-safe/index.js',
    'node_modules/redis-compatible/index.js',
    'node_modules/@upstash/redis/index.js',
    'node_modules/sharpness/index.js',
    'C:\\workspace\\src\\tls.ts',
    'node_modules/pg/../allowed/index.js'
  ])('allows compatible APIs and unrelated filenames: %s', (path) => {
    expect(auditWorkerManifest(manifestImport(path)).violations).toEqual([])
  })

  it('deduplicates violations without changing the original evidence spelling', () => {
    const manifest = manifestImport('node:fs?commonjs-external')
    manifest.outputs['entry.js']!.imports.push({
      path: 'node:fs?commonjs-external',
      kind: 'import-statement',
      external: true
    })
    expect(auditWorkerManifest(manifest, ['node:fs?commonjs-external']).violations).toEqual([
      'node:fs?commonjs-external'
    ])
  })

  it('accepts actual metadata fields, zero byte modules, CSS/assets, and sourcemap outputs', () => {
    const manifest = validManifest()
    manifest.inputs['workers/entry.ts']!.with = { type: 'javascript' }
    manifest.inputs['workers/entry.ts']!.imports.push({
      path: 'node:buffer',
      kind: 'require-call',
      external: true,
      original: 'buffer',
      with: { type: 'javascript' }
    })
    manifest.inputs['empty.ts'] = { bytes: 0, imports: [], format: 'cjs' }
    manifest.inputs['style.css'] = { bytes: 10, imports: [{ path: 'theme.css', kind: 'import-rule' }] }
    manifest.inputs['theme.css'] = { bytes: 10, imports: [] }
    manifest.outputs['entry.js']!.inputs['empty.ts'] = { bytesInOutput: 0 }
    manifest.outputs['entry.js']!.cssBundle = 'entry.css'
    manifest.outputs['entry.js']!.imports.push({ path: 'asset.svg', kind: 'file-loader' })
    manifest.outputs['entry.css'] = {
      bytes: 20,
      inputs: { 'style.css': { bytesInOutput: 10 }, 'theme.css': { bytesInOutput: 10 } },
      imports: [],
      exports: []
    }
    manifest.outputs['entry.js.map'] = { bytes: 20, inputs: {}, imports: [], exports: [] }
    manifest.outputs['asset.svg'] = { bytes: 20, inputs: {}, imports: [], exports: [] }
    expect(auditWorkerManifest(manifest).violations).toEqual([])
  })

  describe('fail-closed manifest evidence', () => {
    it.each([undefined, null, false, 0, '', [], {}, { inputs: {} }, { outputs: {} }, { inputs: {}, outputs: {} }])(
      'rejects absent or empty evidence %j without throwing',
      (manifest) => {
        expect(auditWorkerManifest(manifest).violations.length).toBeGreaterThan(0)
      }
    )

    it.each([null, [], false, 'not a map', new Date(testNow()), new Map()])(
      'rejects malformed record maps %j',
      (value) => {
        const manifest = validManifest()
        for (const section of ['inputs', 'outputs']) {
          expect(auditWorkerManifest({ ...manifest, [section]: value }).violations).toContain(
            `invalid_manifest:${section}`
          )
        }
      }
    )

    it('does not accept inherited metadata evidence', () => {
      expect(auditWorkerManifest(Object.create(validManifest())).violations).toEqual(['invalid_manifest:$'])
    })

    it('accepts safe dictionary maps with null prototypes', () => {
      const manifest = validManifest()
      manifest.inputs = Object.assign(Object.create(null), manifest.inputs)
      manifest.outputs = Object.assign(Object.create(null), manifest.outputs)
      expect(auditWorkerManifest(manifest).violations).toEqual([])
    })

    it.each([null, [], false, 10, 'metadata', {}])('rejects malformed per-module values %j', (value) => {
      for (const section of ['inputs', 'outputs']) {
        const manifest = validManifest()
        Object.assign(manifest[section as keyof WorkerBundleManifest], { 'other.js': value })
        expect(auditWorkerManifest(manifest).violations.length).toBeGreaterThan(0)
      }
    })

    it.each([undefined, null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '100'])(
      'rejects invalid byte counts %s',
      (bytes) => {
        const manifest = validManifest()
        Object.assign(manifest.inputs['workers/entry.ts']!, { bytes })
        Object.assign(manifest.outputs['entry.js']!, { bytes })
        Object.assign(manifest.outputs['entry.js']!.inputs['workers/entry.ts']!, { bytesInOutput: bytes })
        const result = auditWorkerManifest(manifest)
        expect(result.violations).toContain('invalid_manifest:inputs["workers/entry.ts"].bytes')
        expect(result.violations).toContain('invalid_manifest:outputs["entry.js"].bytes')
        expect(result.violations).toContain('invalid_manifest:outputs["entry.js"].inputs["workers/entry.ts"]')
      }
    )

    it.each([undefined, null, {}, 'node:fs', 1])('rejects malformed imports collections %j', (imports) => {
      const manifest = validManifest()
      Object.assign(manifest.inputs['workers/entry.ts']!, { imports })
      Object.assign(manifest.outputs['entry.js']!, { imports })
      const result = auditWorkerManifest(manifest)
      expect(result.violations).toContain('invalid_manifest:inputs["workers/entry.ts"].imports')
      expect(result.violations).toContain('invalid_manifest:outputs["entry.js"].imports')
    })

    it.each([
      null,
      [],
      1,
      'node:fs',
      {},
      { path: 'node:crypto' },
      { path: false, kind: 'import-statement' },
      { path: '', kind: 'import-statement' },
      { path: ' ', kind: 'import-statement' },
      { path: '?commonjs-external', kind: 'import-statement' },
      { path: 'external: node:fs', kind: 'import-statement' },
      { path: 'node:fs ?commonjs-external', kind: 'import-statement' },
      { path: '\0', kind: 'import-statement' },
      { path: '\nnode:fs', kind: 'import-statement' },
      { path: 'node:fs\t', kind: 'import-statement' },
      { path: ' node:fs', kind: 'import-statement' },
      { path: 'src/\0file.ts', kind: 'import-statement' },
      { path: 'src/\u007ffile.ts', kind: 'import-statement' },
      { path: 'node:crypto', kind: null },
      { path: 'node:crypto', kind: ['import-statement'] },
      { path: 'node:crypto', kind: 'invented-import' },
      { path: 'node:crypto', kind: 'file-loader' },
      { path: 'node:crypto', kind: 'import-statement', external: 'true' },
      { path: 'node:crypto', kind: 'import-statement', original: null },
      { path: 'node:crypto', kind: 'import-statement', with: null },
      { path: 'node:crypto', kind: 'import-statement', with: { type: 1 } }
    ])('rejects malformed imports %j', (entry) => {
      const manifest = validManifest()
      Object.assign(manifest.inputs['workers/entry.ts']!, { imports: [entry] })
      expect(auditWorkerManifest(manifest).violations.length).toBeGreaterThan(0)
    })

    it.each([null, {}, 'default', [1], [undefined], Array(1)])('rejects malformed output exports %j', (exports) => {
      const manifest = validManifest()
      Object.assign(manifest.outputs['entry.js']!, { exports })
      expect(auditWorkerManifest(manifest).violations).toContain('invalid_manifest:outputs["entry.js"].exports')
    })

    it.each([null, [], 1, 'input'])('rejects malformed output input attribution %j', (inputs) => {
      const manifest = validManifest()
      Object.assign(manifest.outputs['entry.js']!, { inputs })
      expect(auditWorkerManifest(manifest).violations).toContain('invalid_manifest:outputs["entry.js"].inputs')
    })

    it('rejects structurally plausible but unlinked output evidence', () => {
      const manifest = validManifest()
      manifest.outputs['entry.js']!.inputs = {}
      expect(auditWorkerManifest(manifest).violations).toContain('invalid_manifest:outputs.missing_input_attribution')
    })

    it('rejects nonexistent input, entrypoint and CSS references while inspecting their paths', () => {
      const manifest = validManifest()
      manifest.outputs['entry.js']!.inputs['node_modules/pg/index.js'] = { bytesInOutput: 10 }
      manifest.outputs['entry.js']!.entryPoint = 'missing.ts'
      manifest.outputs['entry.js']!.cssBundle = 'missing.css'
      const result = auditWorkerManifest(manifest)
      expect(result.violations).toContain('node_modules/pg/index.js')
      expect(result.violations).toContain(
        'invalid_manifest:outputs["entry.js"].inputs["node_modules/pg/index.js"].missing_input'
      )
      expect(result.violations).toContain('invalid_manifest:outputs["entry.js"].entryPoint.missing_input')
      expect(result.violations).toContain('invalid_manifest:outputs["entry.js"].cssBundle.missing_output')
    })

    it('rejects empty module keys', () => {
      const manifest = validManifest()
      manifest.inputs[''] = { bytes: 0, imports: [] }
      expect(auditWorkerManifest(manifest).violations).toContain('invalid_manifest:inputs[""]')
    })

    it.each([null, ['esm'], 'unknown'])('rejects malformed optional input format %j', (format) => {
      const manifest = validManifest()
      Object.assign(manifest.inputs['workers/entry.ts']!, { format })
      expect(auditWorkerManifest(manifest).violations).toContain('invalid_manifest:inputs["workers/entry.ts"].format')
    })

    it('retains forbidden path evidence even when its metadata is malformed', () => {
      const manifest = validManifest()
      Object.assign(manifest.inputs, { 'node_modules/redis/index.js': null })
      expect(auditWorkerManifest(manifest).violations).toContain('node_modules/redis/index.js')
    })
  })

  describe('separate original source-map evidence', () => {
    it.each(forbiddenPaths)('rejects forbidden original source %s', (path) => {
      expect(auditWorkerManifest(validManifest(), new Set([path])).violations).toEqual([path])
    })

    it('supplements graph inspection without overwriting or repairing its metadata', () => {
      const manifest = validManifest()
      const before = structuredClone(manifest)
      expect(auditWorkerManifest(manifest, ['workers/source.ts', 'node:buffer']).inspected).toBe(6)
      expect(manifest).toEqual(before)
      expect(auditWorkerManifest({}, ['workers/source.ts']).violations).toContain('invalid_manifest:inputs')
      expect(auditWorkerManifest({}, ['workers/source.ts']).violations).toContain('invalid_manifest:outputs')
    })

    it.each([null, false, 1, {}, 'node:fs'])('rejects malformed source collections %j', (sources) => {
      expect(auditWorkerManifest(validManifest(), sources as never).violations).toContain(
        'invalid_source_evidence:iterable'
      )
    })

    it.each([null, false, 1, {}, '', '?external'])('rejects malformed original source paths %j', (path) => {
      expect(auditWorkerManifest(validManifest(), [path] as never).violations).toContain('invalid_manifest:sources[0]')
    })

    it('fails closed if source evidence iteration is interrupted', () => {
      const sources = {
        *[Symbol.iterator]() {
          yield 'node:tls'
          throw new Error('corrupt source evidence')
        }
      }
      expect(auditWorkerManifest(validManifest(), sources).violations).toEqual([
        'node:tls',
        'invalid_source_evidence:iteration'
      ])
    })
  })
})
