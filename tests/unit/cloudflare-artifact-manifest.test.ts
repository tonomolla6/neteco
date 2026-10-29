import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createCloudflareArtifactEvidence,
  verifyCloudflareArtifactEvidence,
  type CloudflareArtifactToolchain
} from '../../scripts/lib/cloudflare-artifact-manifest'

const owned: string[] = []
const toolchain: CloudflareArtifactToolchain = {
  node: '24.18.1',
  npm: '11.16.0',
  wrangler: '4.66.0',
  compatibilityDate: '2026-08-15',
  compatibilityFlags: ['nodejs_compat']
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'neteco-artifact-unit-'))
  owned.push(rootDirectory)
  const put = async (path: string, content: unknown) => {
    await mkdir(dirname(join(rootDirectory, path)), { recursive: true })
    await writeFile(join(rootDirectory, path), typeof content === 'string' ? content : JSON.stringify(content))
  }
  await put('package.json', {
    name: 'artifact-fixture',
    version: '1.0.0',
    engines: { node: toolchain.node, npm: toolchain.npm },
    packageManager: 'npm@11.16.0',
    dependencies: { tiny: '1.0.0' },
    devDependencies: { wrangler: toolchain.wrangler }
  })
  await put('package-lock.json', {
    name: 'artifact-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'artifact-fixture', version: '1.0.0' },
      'node_modules/tiny': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz',
        integrity: 'sha512-Zml4dHVyZQ=='
      },
      'node_modules/wrangler': { version: toolchain.wrangler }
    }
  })
  await put('.node-version', toolchain.node + '\n')
  await put('node_modules/tiny/package.json', { name: 'tiny', version: '1.0.0' })
  await put('node_modules/tiny/index.js', 'export const value=1;\n')
  await put('node_modules/wrangler/package.json', { name: 'wrangler', version: toolchain.wrangler })
  await put('.wrangler/shop/wrangler.json', {
    name: 'artifact-fixture',
    main: '../../workers/shop.ts',
    compatibility_date: toolchain.compatibilityDate,
    compatibility_flags: toolchain.compatibilityFlags
  })
  await put('.output-cloudflare/server/index.mjs', 'export default {fetch(){return new Response("fixture")}};\n')
  await put('.output-cloudflare/server/index.mjs.map', {
    version: 3,
    sources: ['node_modules/tiny/index.js'],
    names: [],
    mappings: ''
  })
  await put('.output-cloudflare/public/index.html', '<!doctype html><title>Fixture</title>')
  await put('.wrangler/shop-bundle/shop.js', 'export default {fetch(){return new Response("fixture")}};\n')
  const worker = await readFile(join(rootDirectory, '.wrangler/shop-bundle/shop.js'), 'utf8')
  await put('.wrangler/shop-meta.json', {
    inputs: {
      'node_modules/tiny/index.js': { bytes: 22, format: 'esm', imports: [] }
    },
    outputs: {
      '.wrangler/shop-bundle/shop.js': {
        bytes: Buffer.byteLength(worker),
        imports: [],
        exports: ['default'],
        inputs: { 'node_modules/tiny/index.js': { bytesInOutput: 1 } }
      }
    }
  })
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: { type: 'application', name: 'artifact-fixture', version: '1.0.0', 'bom-ref': 'fixture' } },
    components: [
      { type: 'library', name: 'tiny', version: '1.0.0', purl: 'pkg:npm/tiny@1.0.0', 'bom-ref': 'pkg:npm/tiny@1.0.0' },
      {
        type: 'library',
        name: 'wrangler',
        version: toolchain.wrangler,
        purl: `pkg:npm/wrangler@${toolchain.wrangler}`,
        'bom-ref': `pkg:npm/wrangler@${toolchain.wrangler}`
      }
    ],
    dependencies: [{ ref: 'fixture', dependsOn: ['pkg:npm/tiny@1.0.0', `pkg:npm/wrangler@${toolchain.wrangler}`] }]
  }
  return { rootDirectory, put, sbom, input: { rootDirectory, sbom, toolchain } }
}
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true })
})

it('emits deterministic evidence tied to real bytes, a lock SBOM and reachable package versions', async () => {
  const f = await fixture()
  const first = await createCloudflareArtifactEvidence(f.input)
  expect(await createCloudflareArtifactEvidence(f.input)).toEqual(first)
  expect(first.manifest).toMatchObject({
    schemaVersion: 1,
    scope: 'local_cloudflare_build',
    toolchain,
    sbom: { scope: 'lock_supply_chain' },
    claims: {
      reproducibleBuild: 'not_verified',
      startup: 'not_measured',
      vulnerabilities: 'not_assessed',
      productionAcceptance: false
    }
  })
  expect(first.manifest.runtimePackages).toEqual([
    { name: 'tiny', version: '1.0.0', purl: 'pkg:npm/tiny@1.0.0', lockPath: 'node_modules/tiny' }
  ])
  const worker = first.manifest.artifacts.find((item) => item.path === '.wrangler/shop-bundle/shop.js')!
  const bytes = await readFile(join(f.rootDirectory, worker.path))
  expect(worker.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(worker.bytes).toBe(bytes.byteLength)
  expect(worker.gzipBytes).toBeGreaterThan(0)
  expect(first.manifest.lock.sha256).toBe(sha(await readFile(join(f.rootDirectory, 'package-lock.json'), 'utf8')))
  await expect(
    verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence: first })
  ).resolves.toBeUndefined()
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2 * 1024 * 1024)
})

it('accepts npm 11 lock-only root folder display name while proving the root package identity from its canonical ref and PURL', async () => {
  const f = await fixture()
  // Official npm 11.16.0 CycloneDX output uses node.name (folder basename)
  // for the root display name, but node.packageName/pkgid for these identities.
  const sbom = structuredClone(f.sbom)
  Object.assign(sbom.metadata.component, {
    name: basename(f.rootDirectory),
    'bom-ref': 'artifact-fixture@1.0.0',
    purl: 'pkg:npm/artifact-fixture@1.0.0'
  })
  sbom.dependencies[0]!.ref = 'artifact-fixture@1.0.0'
  const evidence = await createCloudflareArtifactEvidence({ ...f.input, sbom })
  expect(evidence.sbom.metadata).toMatchObject({
    component: { name: 'artifact-fixture', version: '1.0.0', 'bom-ref': 'artifact-fixture@1.0.0' }
  })
  await expect(verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence })).resolves.toBeUndefined()
})

it.each(['purl', 'ref', 'folder'])('rejects an npm root display alias with a mismatched %s', async (mismatch) => {
  const f = await fixture()
  const sbom = structuredClone(f.sbom)
  Object.assign(sbom.metadata.component, {
    name: mismatch === 'folder' ? 'unrelated-checkout' : basename(f.rootDirectory),
    'bom-ref': mismatch === 'ref' ? 'unrelated@1.0.0' : 'artifact-fixture@1.0.0',
    purl: mismatch === 'purl' ? 'pkg:npm/unrelated@1.0.0' : 'pkg:npm/artifact-fixture@1.0.0'
  })
  sbom.dependencies[0]!.ref = sbom.metadata.component['bom-ref']
  await expect(createCloudflareArtifactEvidence({ ...f.input, sbom })).rejects.toMatchObject({ code: 'invalid_sbom' })
})

it.each([
  '.wrangler/shop-bundle/shop.js',
  '.wrangler/shop-meta.json',
  'package-lock.json',
  '.output-cloudflare/public/index.html'
])('rejects post-emission drift in %s instead of trusting a stale manifest', async (path) => {
  const f = await fixture()
  const evidence = await createCloudflareArtifactEvidence(f.input)
  await f.put(path, (await readFile(join(f.rootDirectory, path), 'utf8')) + '\n')
  await expect(verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence })).rejects.toMatchObject({
    code: 'artifact_drift'
  })
})

it('resolves real Wrangler metafile paths relative to its generated config without admitting traversal', async () => {
  const f = await fixture()
  const bytes = (await readFile(join(f.rootDirectory, '.wrangler/shop-bundle/shop.js'))).length
  await f.put('.wrangler/shop-meta.json', {
    inputs: {
      '../../node_modules/tiny/index.js': { bytes: 22, format: 'esm', imports: [] }
    },
    outputs: {
      '../shop-bundle/shop.js': {
        bytes,
        imports: [],
        exports: ['default'],
        inputs: { '../../node_modules/tiny/index.js': { bytesInOutput: 1 } }
      }
    }
  })
  const evidence = await createCloudflareArtifactEvidence(f.input)
  expect(evidence.manifest.runtimePackages).toEqual([
    { name: 'tiny', version: '1.0.0', purl: 'pkg:npm/tiny@1.0.0', lockPath: 'node_modules/tiny' }
  ])
  await expect(verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence })).resolves.toBeUndefined()
})

it('hashes public virtual source maps without claiming browser-only modules as Worker runtime dependencies', async () => {
  const f = await fixture()
  const path = '.output-cloudflare/public/browser.js.map'
  await f.put(path, { version: 3, sources: ['\u0000virtual:browser-only'], names: [], mappings: '' })
  const evidence = await createCloudflareArtifactEvidence(f.input)
  expect(evidence.manifest.runtimePackages.map((item) => item.name)).toEqual(['tiny'])
  const artifact = evidence.manifest.artifacts.find((item) => item.path === path)
  expect(artifact?.sha256).toBe(sha(await readFile(join(f.rootDirectory, path), 'utf8')))
  await expect(verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence })).resolves.toBeUndefined()
  await f.put(path, { version: 3, sources: ['\u0000virtual:changed-browser-only'], names: [], mappings: '' })
  await expect(verifyCloudflareArtifactEvidence({ rootDirectory: f.rootDirectory, evidence })).rejects.toMatchObject({
    code: 'artifact_drift'
  })
})

it('continues rejecting virtual control characters in Worker server source-map evidence', async () => {
  const f = await fixture()
  await f.put('.output-cloudflare/server/index.mjs.map', {
    version: 3,
    sources: ['\u0000virtual:server-only'],
    names: [],
    mappings: ''
  })
  await expect(createCloudflareArtifactEvidence(f.input)).rejects.toMatchObject({ code: 'evidence_unavailable' })
})

it('rejects symlinks even when their targets are other owned fixture files', async () => {
  const f = await fixture()
  await symlink(
    join(f.rootDirectory, 'package-lock.json'),
    join(f.rootDirectory, '.output-cloudflare/public/lock-link.json')
  )
  await expect(createCloudflareArtifactEvidence(f.input)).rejects.toMatchObject({ code: 'unsafe_path' })
})

it('rejects traversal in dependency evidence without reading outside the fixture', async () => {
  const f = await fixture()
  await f.put('.wrangler/shop-meta.json', {
    inputs: { '../outside.js': { bytes: 1, imports: [] } },
    outputs: {
      '.wrangler/shop-bundle/shop.js': {
        bytes: 1,
        imports: [],
        exports: [],
        inputs: { '../outside.js': { bytesInOutput: 1 } }
      }
    }
  })
  await expect(createCloudflareArtifactEvidence(f.input)).rejects.toMatchObject({ code: 'unsafe_path' })
})

it('rejects reachable package versions that disagree with the actual lock', async () => {
  const f = await fixture()
  await f.put('node_modules/tiny/package.json', { name: 'tiny', version: '2.0.0' })
  await expect(createCloudflareArtifactEvidence(f.input)).rejects.toMatchObject({ code: 'unresolved_runtime_package' })
})

it.each(['malformed', 'duplicate', 'credential_url', 'missing_runtime'])(
  'rejects %s SBOM evidence instead of declaring the build inventoried',
  async (variant) => {
    const f = await fixture()
    const sbom = structuredClone(f.sbom)
    if (variant === 'duplicate') sbom.components.push(structuredClone(sbom.components[0]!))
    if (variant === 'missing_runtime') sbom.components = sbom.components.slice(1)
    if (variant === 'credential_url')
      Object.assign(sbom.components[0]!, {
        externalReferences: [{ type: 'distribution', url: 'https://private:credential@registry.invalid/tiny.tgz' }]
      })
    await expect(
      createCloudflareArtifactEvidence({ ...f.input, sbom: variant === 'malformed' ? {} : sbom })
    ).rejects.toMatchObject({ code: 'invalid_sbom' })
  }
)
