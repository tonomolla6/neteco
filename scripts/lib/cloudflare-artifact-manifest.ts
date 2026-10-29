import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { createGzip } from 'node:zlib'
import { auditWorkerManifest, type WorkerBundleManifest } from './worker-bundle-policy'
import { originalWorkerSources } from './worker-source-map'

export const CLOUDFLARE_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
function fail(code: string): never {
  throw new CloudflareArtifactEvidenceError(code)
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Canonical bytes omit npm's per-invocation timestamp/UUID, not dependency facts. */
export function cloudflareEvidenceJson(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical)
    if (!record(item)) return item
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, canonical(item[key])])
    )
  }
  return JSON.stringify(canonical(value))
}

export interface CloudflareArtifactToolchain {
  node: string
  npm: string
  wrangler: string
  compatibilityDate: string
  compatibilityFlags: string[]
}
export interface CloudflareArtifactManifest {
  schemaVersion: 1
  scope: 'local_cloudflare_build'
  toolchain: CloudflareArtifactToolchain
  lock: { sha256: string }
  sbom: { scope: 'lock_supply_chain'; sha256: string }
  runtimePackages: Array<{ name: string; version: string; purl: string; lockPath: string }>
  artifacts: Array<{ path: string; bytes: number; sha256: string; gzipBytes?: number }>
  claims: {
    reproducibleBuild: 'not_verified'
    startup: 'not_measured'
    vulnerabilities: 'not_assessed'
    productionAcceptance: false
  }
}
export interface CloudflareArtifactEvidence {
  manifest: CloudflareArtifactManifest
  sbom: Record<string, unknown>
}
export class CloudflareArtifactEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CloudflareArtifactEvidenceError'
  }
}
/** Never follow a symlink, including a parent of a declared artifact. */
export async function cloudflareArtifactPath(root: string, path: string): Promise<string> {
  if (!path || path.includes('\\') || path.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(path)) fail('unsafe_path')
  const absolute = resolve(root, path)
  const local = relative(root, absolute)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) fail('unsafe_path')
  let current = root
  for (const part of local.split(sep)) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) fail('unsafe_path')
  }
  return absolute
}

export async function readCloudflareArtifactJson(root: string, path: string): Promise<unknown> {
  const absolute = await cloudflareArtifactPath(root, path)
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) fail('invalid_artifact')
    return JSON.parse(await file.readFile('utf8')) as unknown
  } finally {
    await file.close()
  }
}

async function files(root: string, path: string, output: Set<string>): Promise<void> {
  const absolute = await cloudflareArtifactPath(root, path)
  const stat = await lstat(absolute)
  if (stat.isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) await files(root, `${path}/${name}`, output)
  } else if (stat.isFile()) output.add(path)
  else fail('unsafe_path')
  if (output.size > 10_000) fail('evidence_too_large')
}

async function fingerprint(root: string, path: string): Promise<CloudflareArtifactManifest['artifacts'][number]> {
  const absolute = await cloudflareArtifactPath(root, path)
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) fail('invalid_artifact')
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const artifact: CloudflareArtifactManifest['artifacts'][number] = {
      path,
      bytes: stat.size,
      sha256: hash.digest('hex')
    }
    if (path === '.wrangler/shop-bundle/shop.js') {
      // Stream compression: report measured compressed bytes without another output file.
      let gzipBytes = 0
      const stream = file.createReadStream({ start: 0, autoClose: false }).pipe(createGzip({ level: 9 }))
      for await (const chunk of stream) gzipBytes += (chunk as Buffer).length
      artifact.gzipBytes = gzipBytes
    }
    return artifact
  } finally {
    await file.close()
  }
}

function packageName(path: string): string {
  const suffix = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length).split('/')
  return suffix[0]?.startsWith('@') ? `${suffix[0]}/${suffix[1]}` : (suffix[0] ?? '')
}
function purl(name: string, version: string) {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`
}

function normalizeSbom(
  raw: unknown,
  lock: Record<string, unknown>,
  name: string,
  version: string,
  rootBasename: string
): Record<string, unknown> {
  if (
    !record(raw) ||
    raw.bomFormat !== 'CycloneDX' ||
    !['1.5', '1.6'].includes(String(raw.specVersion)) ||
    !record(raw.metadata) ||
    !record(raw.metadata.component) ||
    !Array.isArray(raw.components) ||
    !Array.isArray(raw.dependencies)
  )
    fail('invalid_sbom')
  const root = raw.metadata.component
  if (root.version !== version || !text(root['bom-ref'])) fail('invalid_sbom')
  // npm's loadVirtual root node may retain the checkout folder as its display
  // name. Accept only that actual folder alias with both canonical identities.
  if (
    root.name !== name &&
    (root.name !== rootBasename || root['bom-ref'] !== `${name}@${version}` || root.purl !== purl(name, version))
  )
    fail('invalid_sbom')
  const expected = new Set(
    Object.entries(lock)
      .filter(([path]) => path)
      .map(([path, entry]) => {
        if (!record(entry) || !text(entry.version)) fail('invalid_lock')
        return `${text(entry.name) ? entry.name : packageName(path)}@${entry.version}`
      })
  )
  const refs = new Set<string>([root['bom-ref']])
  const represented = new Set<string>()
  function safeUrl(value: unknown): string {
    if (!text(value)) fail('invalid_sbom')
    try {
      const url = new URL(value)
      if (
        !['https:', 'http:', 'git+https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        fail('invalid_sbom')
    } catch {
      fail('invalid_sbom')
    }
    return value
  }
  const components = raw.components
    .map((component) => {
      if (
        !record(component) ||
        !text(component.name) ||
        !text(component.version) ||
        !text(component['bom-ref']) ||
        !text(component.purl) ||
        refs.has(component['bom-ref']) ||
        !expected.has(`${component.name}@${component.version}`)
      )
        fail('invalid_sbom')
      const canonicalPurl = purl(component.name, component.version)
      if (component.purl !== canonicalPurl && component.purl !== canonicalPurl.replace('%40', '@')) fail('invalid_sbom')
      refs.add(component['bom-ref'])
      const identity = `${component.name}@${component.version}`
      if (represented.has(identity)) fail('invalid_sbom')
      represented.add(identity)
      const result: Record<string, unknown> = {
        type: 'library',
        name: component.name,
        version: component.version,
        'bom-ref': component['bom-ref'],
        purl: canonicalPurl
      }
      if (component.scope !== undefined) {
        if (!['required', 'optional', 'excluded'].includes(String(component.scope))) fail('invalid_sbom')
        result.scope = component.scope
      }
      if (component.externalReferences !== undefined) {
        if (!Array.isArray(component.externalReferences)) fail('invalid_sbom')
        result.externalReferences = component.externalReferences.map((entry) => {
          if (!record(entry) || !text(entry.type)) fail('invalid_sbom')
          return { type: entry.type, url: safeUrl(entry.url) }
        })
      }
      if (component.hashes !== undefined) {
        if (!Array.isArray(component.hashes)) fail('invalid_sbom')
        result.hashes = component.hashes.map((entry) => {
          if (
            !record(entry) ||
            !['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(String(entry.alg)) ||
            !text(entry.content) ||
            !/^[a-f\d]+$/i.test(entry.content)
          )
            fail('invalid_sbom')
          return { alg: entry.alg, content: entry.content }
        })
      }
      if (component.licenses !== undefined) {
        if (!Array.isArray(component.licenses)) fail('invalid_sbom')
        result.licenses = component.licenses.map((entry) => {
          if (!record(entry)) fail('invalid_sbom')
          if (text(entry.expression)) return { expression: entry.expression }
          if (!record(entry.license)) fail('invalid_sbom')
          if (text(entry.license.id)) return { license: { id: entry.license.id } }
          if (text(entry.license.name)) return { license: { name: entry.license.name } }
          fail('invalid_sbom')
        })
      }
      return result
    })
    .sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref']), 'en'))
  if (expected.size !== represented.size || [...expected].some((item) => !represented.has(item))) fail('invalid_sbom')
  const dependencies = raw.dependencies
    .map((entry) => {
      if (
        !record(entry) ||
        !text(entry.ref) ||
        !refs.has(entry.ref) ||
        !Array.isArray(entry.dependsOn) ||
        entry.dependsOn.some((ref) => !text(ref) || !refs.has(ref)) ||
        new Set(entry.dependsOn).size !== entry.dependsOn.length
      )
        fail('invalid_sbom')
      return { ref: entry.ref, dependsOn: [...entry.dependsOn].sort() }
    })
    .sort((a, b) => a.ref.localeCompare(b.ref, 'en'))
  if (new Set(dependencies.map((entry) => entry.ref)).size !== dependencies.length) fail('invalid_sbom')
  return {
    bomFormat: 'CycloneDX',
    specVersion: raw.specVersion,
    version: 1,
    metadata: {
      component: { type: 'application', name, version, 'bom-ref': root['bom-ref'] },
      lifecycles: [{ phase: 'pre-build' }]
    },
    components,
    dependencies
  }
}

export async function createCloudflareArtifactEvidence(input: {
  rootDirectory: string
  sbom: unknown
  toolchain: CloudflareArtifactToolchain
}): Promise<CloudflareArtifactEvidence> {
  try {
    const root = await realpath(input.rootDirectory)
    const pkg = await readCloudflareArtifactJson(root, 'package.json')
    const lock = await readCloudflareArtifactJson(root, 'package-lock.json')
    const config = await readCloudflareArtifactJson(root, '.wrangler/shop/wrangler.json')
    const wrangler = await readCloudflareArtifactJson(root, 'node_modules/wrangler/package.json')
    if (
      !record(pkg) ||
      !text(pkg.name) ||
      !text(pkg.version) ||
      !record(lock) ||
      lock.lockfileVersion !== 3 ||
      !record(lock.packages) ||
      !record(lock.packages['']) ||
      lock.name !== pkg.name ||
      lock.version !== pkg.version
    )
      fail('invalid_lock')
    if (
      !record(pkg.engines) ||
      !record(config) ||
      !record(wrangler) ||
      !Array.isArray(config.compatibility_flags) ||
      !config.compatibility_flags.every(text)
    )
      fail('invalid_toolchain')
    const nodeVersionFile = await open(
      await cloudflareArtifactPath(root, '.node-version'),
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    let nodeVersion: string
    try {
      if ((await nodeVersionFile.stat()).size > 100) fail('invalid_toolchain')
      nodeVersion = (await nodeVersionFile.readFile('utf8')).trim()
    } finally {
      await nodeVersionFile.close()
    }
    if (
      input.toolchain.node !== nodeVersion ||
      pkg.engines.node !== nodeVersion ||
      pkg.engines.npm !== input.toolchain.npm ||
      pkg.packageManager !== `npm@${input.toolchain.npm}` ||
      wrangler.version !== input.toolchain.wrangler ||
      config.compatibility_date !== input.toolchain.compatibilityDate ||
      cloudflareEvidenceJson(config.compatibility_flags) !== cloudflareEvidenceJson(input.toolchain.compatibilityFlags)
    )
      fail('invalid_toolchain')
    const sbom = normalizeSbom(input.sbom, lock.packages, pkg.name, pkg.version, basename(root))
    const paths = new Set([
      'package.json',
      'package-lock.json',
      '.node-version',
      '.wrangler/shop/wrangler.json',
      'node_modules/wrangler/package.json',
      '.wrangler/shop-bundle/shop.js',
      '.wrangler/shop-meta.json'
    ])
    await files(root, '.output-cloudflare/server', paths)
    await files(root, '.output-cloudflare/public', paths)
    if (!paths.has('.output-cloudflare/server/index.mjs')) fail('invalid_artifact')
    const manifest = await readCloudflareArtifactJson(root, '.wrangler/shop-meta.json')
    if (!record(manifest) || !record(manifest.inputs) || !record(manifest.outputs)) fail('invalid_artifact')
    const sources = new Set<string>()
    // Browser maps remain byte-for-byte artifacts, but their virtual modules
    // are not evidence of modules reachable in the Worker server bundle.
    for (const path of paths)
      if (path.startsWith('.output-cloudflare/server/') && path.endsWith('.map')) {
        for (const source of originalWorkerSources(await readCloudflareArtifactJson(root, path))) sources.add(source)
      }
    if (!sources.size) fail('invalid_artifact')
    // Wrangler emits paths against the generated configuration's directory.
    // Root-relative metafiles are also supported, but the selected base cannot
    // resolve outside this root. Never guess a base per individual input.
    const metafileBase = Object.hasOwn(manifest.outputs, '.wrangler/shop-bundle/shop.js')
      ? root
      : resolve(root, '.wrangler/shop')
    const metadataPath = (path: string) => relative(root, resolve(metafileBase, path))
    for (const path of [...Object.keys(manifest.inputs), ...Object.keys(manifest.outputs)]) {
      const local = metadataPath(path)
      await cloudflareArtifactPath(root, local)
      if (Object.hasOwn(manifest.outputs, path)) paths.add(local)
    }
    const policy = auditWorkerManifest(manifest as unknown as WorkerBundleManifest, sources)
    if (
      policy.violations.length ||
      [...sources].some((source) => /(?:^|\/)server\/(?:api|middleware|db|integrations|services)\//.test(source))
    )
      fail('invalid_artifact')
    const runtime = new Map<string, CloudflareArtifactManifest['runtimePackages'][number]>()
    for (const source of [...Object.keys(manifest.inputs), ...sources]) {
      const normalized = source.replaceAll('\\', '/')
      const marker = normalized.indexOf('node_modules/')
      if (marker < 0) continue
      const suffix = normalized.slice(marker)
      const pieces = suffix.split('/')
      const last = pieces.lastIndexOf('node_modules')
      const end = last + (pieces[last + 1]?.startsWith('@') ? 3 : 2)
      const lockPath = pieces.slice(0, end).join('/')
      if (runtime.has(lockPath)) continue
      const entry = lock.packages[lockPath]
      if (!record(entry) || !text(entry.version)) fail('unresolved_runtime_package')
      const installed = await readCloudflareArtifactJson(root, `${lockPath}/package.json`)
      const name = text(entry.name) ? entry.name : packageName(lockPath)
      if (!record(installed) || installed.name !== name || installed.version !== entry.version)
        fail('unresolved_runtime_package')
      runtime.set(lockPath, { name, version: entry.version, purl: purl(name, entry.version), lockPath })
      paths.add(`${lockPath}/package.json`)
    }
    const artifacts: CloudflareArtifactManifest['artifacts'] = []
    for (const path of [...paths].sort()) artifacts.push(await fingerprint(root, path))
    const worker = artifacts.find((item) => item.path === '.wrangler/shop-bundle/shop.js')!
    const workerKey = Object.keys(manifest.outputs).find(
      (path) => metadataPath(path) === '.wrangler/shop-bundle/shop.js'
    )
    const declared = workerKey ? manifest.outputs[workerKey] : null
    if (!record(declared) || declared.bytes !== worker.bytes) fail('invalid_artifact')
    const evidence: CloudflareArtifactEvidence = {
      sbom,
      manifest: {
        schemaVersion: 1,
        scope: 'local_cloudflare_build',
        toolchain: structuredClone(input.toolchain),
        lock: { sha256: artifacts.find((item) => item.path === 'package-lock.json')!.sha256 },
        sbom: { scope: 'lock_supply_chain', sha256: sha(cloudflareEvidenceJson(sbom)) },
        runtimePackages: [...runtime.values()].sort((a, b) => a.lockPath.localeCompare(b.lockPath, 'en')),
        artifacts,
        claims: {
          reproducibleBuild: 'not_verified',
          startup: 'not_measured',
          vulnerabilities: 'not_assessed',
          productionAcceptance: false
        }
      }
    }
    if (Buffer.byteLength(cloudflareEvidenceJson(evidence)) > CLOUDFLARE_EVIDENCE_MAX_BYTES) fail('evidence_too_large')
    return evidence
  } catch (error) {
    if (error instanceof CloudflareArtifactEvidenceError) throw error
    fail('evidence_unavailable')
  }
}
export async function verifyCloudflareArtifactEvidence(input: {
  rootDirectory: string
  evidence: unknown
}): Promise<void> {
  try {
    if (
      !record(input.evidence) ||
      !record(input.evidence.manifest) ||
      !Array.isArray(input.evidence.manifest.artifacts)
    )
      fail('artifact_drift')
    const root = await realpath(input.rootDirectory)
    // Hash first: even parseable changes to the lock/metafile are artifact drift.
    for (const item of input.evidence.manifest.artifacts) {
      if (!record(item) || !text(item.path)) fail('artifact_drift')
      if (cloudflareEvidenceJson(await fingerprint(root, item.path)) !== cloudflareEvidenceJson(item))
        fail('artifact_drift')
    }
    const actual = await createCloudflareArtifactEvidence({
      rootDirectory: root,
      sbom: input.evidence.sbom,
      toolchain: input.evidence.manifest.toolchain as CloudflareArtifactToolchain
    })
    if (cloudflareEvidenceJson(actual) !== cloudflareEvidenceJson(input.evidence)) fail('artifact_drift')
  } catch (error) {
    if (error instanceof CloudflareArtifactEvidenceError && error.code === 'unsafe_path') throw error
    fail('artifact_drift')
  }
}
