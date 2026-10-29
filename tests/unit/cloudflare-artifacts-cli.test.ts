import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const cli = new URL('../../scripts/emit-cloudflare-artifacts.ts', import.meta.url).pathname

it('emits bounded evidence offline and verifies actual artifacts rather than accepting stale files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neteco-artifact-cli-'))
  async function put(path: string, value: unknown) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  async function run(args: string[]) {
    try {
      const result = await execute(process.execPath, ['--import', 'tsx', cli, ...args], {
        cwd: process.cwd(),
        timeout: 15000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' }
      })
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const result = error as { code?: number | string; stdout?: string; stderr?: string }
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    }
  }
  try {
    await put('package.json', {
      name: 'artifact-cli-fixture',
      version: '1.0.0',
      engines: { node: '24.18.1', npm: '11.16.0' },
      packageManager: 'npm@11.16.0',
      devDependencies: { wrangler: '4.66.0' }
    })
    await put('package-lock.json', {
      name: 'artifact-cli-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'artifact-cli-fixture', version: '1.0.0' },
        'node_modules/wrangler': { version: '4.66.0' }
      }
    })
    await put('.node-version', '24.18.1\n')
    await put('node_modules/wrangler/package.json', { name: 'wrangler', version: '4.66.0' })
    await put('.wrangler/shop/wrangler.json', {
      name: 'artifact-cli-fixture',
      compatibility_date: '2026-08-15',
      compatibility_flags: ['nodejs_compat']
    })
    await put('workers/shop.ts', 'export default {};\n')
    await put('.wrangler/shop-bundle/shop.js', 'export default {};\n')
    await put('.wrangler/shop-meta.json', {
      inputs: { 'workers/shop.ts': { bytes: 19, format: 'esm', imports: [] } },
      outputs: {
        '.wrangler/shop-bundle/shop.js': {
          bytes: 19,
          imports: [],
          exports: ['default'],
          inputs: { 'workers/shop.ts': { bytesInOutput: 19 } }
        }
      }
    })
    await put('.output-cloudflare/server/index.mjs', 'export default {};\n')
    await put('.output-cloudflare/server/index.mjs.map', {
      version: 3,
      sources: ['workers/shop.ts'],
      names: [],
      mappings: ''
    })
    await put('.output-cloudflare/public/index.html', '<title>Fixture</title>')
    await put('input-sbom.json', {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      metadata: {
        component: { type: 'application', name: 'artifact-cli-fixture', version: '1.0.0', 'bom-ref': 'fixture' }
      },
      components: [
        {
          type: 'library',
          name: 'wrangler',
          version: '4.66.0',
          purl: 'pkg:npm/wrangler@4.66.0',
          'bom-ref': 'pkg:npm/wrangler@4.66.0'
        }
      ],
      dependencies: [{ ref: 'fixture', dependsOn: ['pkg:npm/wrangler@4.66.0'] }]
    })
    const output = join(root, 'evidence')
    const emitted = await run([`--root=${root}`, `--sbom-input=${join(root, 'input-sbom.json')}`, `--output=${output}`])
    expect(emitted, 'actual CLI must emit evidence from the supplied offline SBOM').toMatchObject({ code: 0 })
    const manifest = join(output, 'manifest.json')
    const sbom = join(output, 'sbom.cdx.json')
    const manifestBytes = await readFile(manifest)
    const sbomBytes = await readFile(sbom)
    expect(manifestBytes.byteLength + sbomBytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(JSON.parse(manifestBytes.toString())).toMatchObject({
      scope: 'local_cloudflare_build',
      sbom: { scope: 'lock_supply_chain' }
    })
    expect((await run([`--root=${root}`, `--manifest=${manifest}`, `--sbom-input=${sbom}`])).code).toBe(0)
    await put('.wrangler/shop-bundle/shop.js', 'export default {tampered:true};\n')
    const drift = await run([`--root=${root}`, `--manifest=${manifest}`, `--sbom-input=${sbom}`])
    expect(drift.code).not.toBe(0)
    expect(drift.stderr).toContain('artifact_drift')
    expect(drift.stdout + drift.stderr).not.toContain(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
