import type { Metafile } from 'esbuild'

export type WorkerBundleManifest = Metafile

const importKinds = new Set([
  'entry-point',
  'import-statement',
  'require-call',
  'dynamic-import',
  'require-resolve',
  'import-rule',
  'composes-from',
  'url-token'
])

// These are backend dependencies, not a blanket ban on Workers' Node compatibility.
const forbiddenPackages = new Set([
  // XLSX is a lazy browser download, never a Node/ZIP codec in the Worker.
  'exceljs',
  'postgres',
  'pg',
  'pg-native',
  'pg-pool',
  'pg-protocol',
  'pg-connection-string',
  'pg-types',
  'pgpass',
  'pg-cursor',
  'pg-query-stream',
  'postgres-array',
  'postgres-bytea',
  'postgres-date',
  'postgres-interval',
  'redis',
  'ioredis',
  'redis-parser',
  'redis-commands',
  'nodemailer',
  'smtp-connection',
  'smtp-server',
  'smtp-client',
  'emailjs',
  'emailjs-smtp-client',
  'sharp',
  'bindings',
  'node-gyp-build',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'ffi-napi',
  'ref-napi'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value !== value.trim()) return false
  const normalized = normalizeModulePath(value)
  return (
    normalized.length > 0 &&
    normalized === normalized.trim() &&
    [...normalized].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  )
}

function isBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function normalizeModulePath(path: string) {
  // Rollup/Vite decorate external specifiers; decorators must not conceal imports.
  let normalized = path.replaceAll('\\', '/')
  const decorator = /^(?:\0+|(?:external|commonjs-external|node-external|__vite-browser-external|npm):)/
  while (decorator.test(normalized)) normalized = normalized.replace(decorator, '')
  // A leading # is a package-import/renderer alias, not a URL fragment.
  // Wrangler retains it in imports.original alongside the resolved path.
  const query = normalized.indexOf('?')
  const fragment = normalized.indexOf('#', normalized.startsWith('#') ? 1 : 0)
  const suffixes = [query, fragment].filter((index) => index >= 0)
  return suffixes.length ? normalized.slice(0, Math.min(...suffixes)) : normalized
}

function packageName(segments: string[], offset: number) {
  const first = segments[offset] ?? ''
  const name = first.startsWith('@') ? `${first}/${segments[offset + 1] ?? ''}` : first
  // npm:pg@8/... and npm:@redis/client@5/... are still the same forbidden packages.
  return name.replace(/@[^/]+$/, '')
}

function isForbiddenPackage(name: string) {
  return (
    forbiddenPackages.has(name) ||
    name.startsWith('@redis/') ||
    name.startsWith('@ioredis/') ||
    /^@img\/sharp(?:-|$)/.test(name)
  )
}

function isForbiddenPath(rawPath: string) {
  const path = normalizeModulePath(rawPath)
  if (/(?:^|\/)tests\/support(?:\/|$)/.test(path)) return true
  if (/\.(?:node|dll|dylib)$|\.so(?:\.\d+)*$/i.test(path)) return true
  if (
    /^(?:fs|net|tls|dgram|child_process|cluster|worker_threads|http2)(?:\/|$)/.test(path) ||
    /(?:^|\/)node:(?:fs|net|tls|dgram|child_process|cluster|worker_threads|http2)(?:\/|$)/.test(path)
  ) {
    return true
  }

  // A local file such as ./fs, src/redis.ts or src/pg/index.ts is not a bare module.
  const segments = path.split('/')
  if (!/^(?:\.|\/|[a-z]:\/)/i.test(path) && isForbiddenPackage(packageName(segments, 0))) return true

  // Resolve dot segments for filesystem package paths, without turning ./fs into fs.
  const filesystemSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..' && filesystemSegments.length && filesystemSegments.at(-1) !== '..') {
      filesystemSegments.pop()
    } else filesystemSegments.push(segment)
  }
  return filesystemSegments.some(
    (segment, index) => segment === 'node_modules' && isForbiddenPackage(packageName(filesystemSegments, index + 1))
  )
}

/** Audit untrusted esbuild metadata before incorporating separate source-map evidence.
 * Invalid evidence is a violation, never an empty successful inspection. */
export function auditWorkerManifest(manifest: unknown, sourcePaths: Iterable<string> = []) {
  const entries: string[] = []
  const violations: string[] = []
  let attributedInputs = 0
  const invalid = (location: string) => violations.push(`invalid_manifest:${location}`)
  function inspectPath(value: unknown, location: string) {
    if (!isPath(value)) return invalid(location)
    entries.push(value)
    if (isForbiddenPath(value)) violations.push(value)
  }
  function inspectImports(value: unknown, location: string, output: boolean) {
    if (!Array.isArray(value)) return invalid(location)
    for (const [index, entry] of value.entries()) {
      const entryLocation = `${location}[${index}]`
      if (!isRecord(entry)) {
        invalid(entryLocation)
        continue
      }
      inspectPath(entry.path, `${entryLocation}.path`)
      if (
        typeof entry.kind !== 'string' ||
        (!importKinds.has(entry.kind) && !(output && entry.kind === 'file-loader'))
      ) {
        invalid(`${entryLocation}.kind`)
      }
      if (Object.hasOwn(entry, 'external') && typeof entry.external !== 'boolean') {
        invalid(`${entryLocation}.external`)
      }
      if (Object.hasOwn(entry, 'original')) inspectPath(entry.original, `${entryLocation}.original`)
      if (Object.hasOwn(entry, 'with')) inspectAttributes(entry.with, `${entryLocation}.with`)
    }
  }
  function inspectAttributes(value: unknown, location: string) {
    if (!isRecord(value) || Object.values(value).some((attribute) => typeof attribute !== 'string')) {
      invalid(location)
    }
  }
  function inspectRecords(value: unknown, location: string, output: boolean) {
    if (!isRecord(value) || !Object.keys(value).length) return invalid(location)
    for (const [path, entry] of Object.entries(value)) {
      const entryLocation = `${location}[${JSON.stringify(path)}]`
      inspectPath(path, entryLocation)
      if (!isRecord(entry)) {
        invalid(entryLocation)
        continue
      }
      if (!isBytes(entry.bytes)) invalid(`${entryLocation}.bytes`)
      inspectImports(entry.imports, `${entryLocation}.imports`, output)
      if (!output) {
        if (
          Object.hasOwn(entry, 'format') &&
          (typeof entry.format !== 'string' || !['cjs', 'esm'].includes(entry.format))
        ) {
          invalid(`${entryLocation}.format`)
        }
        if (Object.hasOwn(entry, 'with')) inspectAttributes(entry.with, `${entryLocation}.with`)
        continue
      }
      if (!Array.isArray(entry.exports) || [...entry.exports].some((name: unknown) => typeof name !== 'string')) {
        invalid(`${entryLocation}.exports`)
      }
      if (!isRecord(entry.inputs)) invalid(`${entryLocation}.inputs`)
      else {
        for (const [input, attribution] of Object.entries(entry.inputs)) {
          const inputLocation = `${entryLocation}.inputs[${JSON.stringify(input)}]`
          inspectPath(input, inputLocation)
          if (!isRecord(attribution) || !isBytes(attribution.bytesInOutput)) invalid(inputLocation)
          if (!isRecord(manifest) || !isRecord(manifest.inputs) || !Object.hasOwn(manifest.inputs, input)) {
            invalid(`${inputLocation}.missing_input`)
          } else attributedInputs++
        }
      }
      for (const field of ['entryPoint', 'cssBundle']) {
        if (!Object.hasOwn(entry, field)) continue
        inspectPath(entry[field], `${entryLocation}.${field}`)
        const references = isRecord(manifest) ? manifest[field === 'entryPoint' ? 'inputs' : 'outputs'] : undefined
        if (!isPath(entry[field]) || !isRecord(references) || !Object.hasOwn(references, entry[field])) {
          invalid(`${entryLocation}.${field}.missing_${field === 'entryPoint' ? 'input' : 'output'}`)
        }
      }
    }
  }

  if (!isRecord(manifest)) invalid('$')
  else {
    inspectRecords(manifest.inputs, 'inputs', false)
    inspectRecords(manifest.outputs, 'outputs', true)
    if (!attributedInputs) invalid('outputs.missing_input_attribution')
  }
  // Source maps supplement the graph, but cannot repair missing/corrupt graph evidence.
  if (!sourcePaths || typeof sourcePaths === 'string' || typeof sourcePaths[Symbol.iterator] !== 'function') {
    violations.push('invalid_source_evidence:iterable')
  } else {
    try {
      let index = 0
      for (const path of sourcePaths) inspectPath(path, `sources[${index++}]`)
    } catch {
      violations.push('invalid_source_evidence:iteration')
    }
  }
  return { inspected: entries.length, violations: [...new Set(violations)] }
}
