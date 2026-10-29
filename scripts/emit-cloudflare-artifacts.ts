import { execFile } from 'node:child_process'
import { mkdir, lstat, writeFile, unlink, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  CLOUDFLARE_EVIDENCE_MAX_BYTES,
  CloudflareArtifactEvidenceError,
  cloudflareArtifactPath,
  cloudflareEvidenceJson,
  createCloudflareArtifactEvidence,
  readCloudflareArtifactJson,
  verifyCloudflareArtifactEvidence
} from './lib/cloudflare-artifact-manifest'

const execute = promisify(execFile)
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(code: string): never {
  throw new CloudflareArtifactEvidenceError(code)
}

async function main() {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const match = /^--(root|output|manifest|sbom-input)=(.+)$/.exec(arg)
    if (!match || args.has(match[1]!)) fail('invalid_arguments')
    args.set(match[1]!, match[2]!)
  }
  if (
    !args.has('root') ||
    args.has('output') === args.has('manifest') ||
    (args.has('manifest') && !args.has('sbom-input'))
  )
    fail('invalid_arguments')
  const root = await realpath(args.get('root')!)
  const read = (path: string) => readCloudflareArtifactJson(root, relative(root, resolve(path)))
  if (args.has('manifest')) {
    await verifyCloudflareArtifactEvidence({
      rootDirectory: root,
      evidence: { manifest: await read(args.get('manifest')!), sbom: await read(args.get('sbom-input')!) }
    })
    process.stdout.write('cloudflare_artifacts_verified\n')
    return
  }
  const pkg = await readCloudflareArtifactJson(root, 'package.json')
  const wrangler = await readCloudflareArtifactJson(root, 'node_modules/wrangler/package.json')
  const config = await readCloudflareArtifactJson(root, '.wrangler/shop/wrangler.json')
  if (
    !object(pkg) ||
    !object(pkg.engines) ||
    typeof pkg.engines.node !== 'string' ||
    typeof pkg.engines.npm !== 'string' ||
    !object(wrangler) ||
    typeof wrangler.version !== 'string' ||
    !object(config) ||
    typeof config.compatibility_date !== 'string' ||
    !Array.isArray(config.compatibility_flags) ||
    !config.compatibility_flags.every((value) => typeof value === 'string')
  )
    fail('invalid_toolchain')
  if (process.versions.node !== pkg.engines.node) fail('invalid_toolchain')
  let sbom: unknown
  if (args.has('sbom-input')) sbom = await read(args.get('sbom-input')!)
  else {
    // The installed npm toolchain only: loadVirtual reads the lock, never installs
    // packages or runs lifecycle scripts. Raw capture is RAM-bounded to 8 MiB;
    // the normalized final evidence remains capped at 2 MiB without truncation.
    const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
    const version = await execute(process.execPath, [npmCli, '--version'], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 1024
    })
    if (version.stdout.trim() !== pkg.engines.npm) fail('invalid_toolchain')
    const generated = await execute(
      process.execPath,
      [npmCli, 'sbom', '--package-lock-only', '--sbom-format=cyclonedx', '--offline', '--ignore-scripts'],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false'
        }
      }
    )
    sbom = JSON.parse(generated.stdout) as unknown
  }
  const evidence = await createCloudflareArtifactEvidence({
    rootDirectory: root,
    sbom,
    toolchain: {
      node: pkg.engines.node,
      npm: pkg.engines.npm,
      wrangler: wrangler.version,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags as string[]
    }
  })
  const manifestBytes = cloudflareEvidenceJson(evidence.manifest) + '\n'
  const sbomBytes = cloudflareEvidenceJson(evidence.sbom) + '\n'
  if (Buffer.byteLength(manifestBytes) + Buffer.byteLength(sbomBytes) > CLOUDFLARE_EVIDENCE_MAX_BYTES)
    fail('evidence_too_large')
  const output = resolve(args.get('output')!)
  const local = relative(root, output)
  if (!local || local === '..' || local.startsWith(`..${sep}`)) fail('unsafe_path')
  // Inspect existing parents BEFORE mkdir, so an output symlink cannot cause
  // writes outside the declared root even when the final directory is absent.
  let current = root
  for (const part of local.split(sep)) {
    current = resolve(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) fail('unsafe_path')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await mkdir(output, { recursive: true, mode: 0o700 })
  await cloudflareArtifactPath(root, local)
  const written: string[] = []
  try {
    for (const [name, bytes] of [
      ['manifest.json', manifestBytes],
      ['sbom.cdx.json', sbomBytes]
    ]) {
      const path = resolve(output, name!)
      await writeFile(path, bytes!, { flag: 'wx', mode: 0o600 })
      written.push(path)
    }
  } catch (error) {
    // Only remove files successfully created by this invocation; never replace
    // an existing manifest, SBOM, or another task's evidence.
    for (const path of written) await unlink(path)
    throw error
  }
  process.stdout.write('cloudflare_artifacts_emitted\n')
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof CloudflareArtifactEvidenceError ? error.code : 'evidence_unavailable'}\n`)
  process.exitCode = 1
}
