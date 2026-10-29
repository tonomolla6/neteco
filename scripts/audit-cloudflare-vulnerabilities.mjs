import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const MAX_REPORT_BYTES = 2 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const severities = ['info', 'low', 'moderate', 'high', 'critical']
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const fail = (code) => {
  throw new Error(code)
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  )
}

// This evaluates npm's recorded assessment, not an independent vulnerability
// database. With identical report/lock bytes the policy decision is repeatable.
export function evaluateNpmVulnerabilities(raw, processStatus, lock) {
  if (
    !object(raw) ||
    raw.auditReportVersion !== 2 ||
    raw.error ||
    !object(raw.vulnerabilities) ||
    !object(raw.metadata) ||
    !object(raw.metadata.vulnerabilities) ||
    !object(raw.metadata.dependencies) ||
    !integer(raw.metadata.dependencies.total) ||
    raw.metadata.dependencies.total === 0 ||
    !object(lock) ||
    !object(lock.packages)
  )
    fail('assessment_unavailable')
  if (![0, 1].includes(processStatus)) fail('scanner_failed')
  const counts = Object.fromEntries(severities.map((severity) => [severity, 0]))
  for (const [name, entry] of Object.entries(raw.vulnerabilities)) {
    if (
      !object(entry) ||
      entry.name !== name ||
      !severities.includes(entry.severity) ||
      !Array.isArray(entry.nodes) ||
      entry.nodes.length === 0 ||
      !entry.nodes.every(
        (path) => typeof path === 'string' && path.endsWith(`node_modules/${name}`) && object(lock.packages[path])
      ) ||
      !Array.isArray(entry.via) ||
      entry.via.length === 0
    )
      fail('invalid_assessment')
    for (const advisory of entry.via) {
      if (typeof advisory === 'string') {
        if (!object(raw.vulnerabilities[advisory])) fail('invalid_assessment')
      } else if (
        !object(advisory) ||
        !severities.includes(advisory.severity) ||
        severities.indexOf(advisory.severity) > severities.indexOf(entry.severity)
      )
        fail('invalid_assessment')
    }
    counts[entry.severity]++
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  for (const severity of severities) {
    if (raw.metadata.vulnerabilities[severity] !== counts[severity]) fail('invalid_assessment')
  }
  if (raw.metadata.vulnerabilities.total !== total) fail('invalid_assessment')
  const blocked = counts.high + counts.critical > 0
  if (processStatus !== (blocked ? 1 : 0)) fail('scanner_status_mismatch')
  return { status: blocked ? 'blocked' : 'passed', counts: { ...counts, total } }
}

async function execute(command, args, options) {
  const { budgetDirectory, ...processOptions } = options
  let monitor
  let checking = false
  let budgetFailed = false
  let child
  try {
    const result = budgetDirectory
      ? await new Promise((accept, reject) => {
          child = execFile(command, args, processOptions, (error, stdout) => {
            if (budgetFailed) reject(new Error('cache_budget_exceeded'))
            else if (error) reject(error)
            else accept({ stdout })
          })
          monitor = setInterval(async () => {
            if (checking) return
            checking = true
            try {
              await cacheSize(budgetDirectory)
            } catch {
              budgetFailed = true
              child.kill('SIGKILL')
            } finally {
              checking = false
            }
          }, 200)
        })
      : await executeFile(command, args, processOptions)
    return { status: 0, stdout: result.stdout }
  } catch (error) {
    if (typeof error.code === 'number' && !error.killed && !error.signal) {
      return { status: error.code, stdout: error.stdout ?? '' }
    }
    fail('process_unavailable')
  } finally {
    if (monitor) clearInterval(monitor)
  }
}

async function safePath(root, path) {
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith(`..${sep}`)) fail('unsafe_path')
  let current = root
  for (const part of local.split(sep)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) fail('unsafe_path')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function boundedRead(root, path, limit = MAX_REPORT_BYTES) {
  await safePath(root, path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) fail('evidence_too_large')
    const bytes = await file.readFile()
    if (bytes.length > limit) fail('evidence_too_large')
    return bytes
  } finally {
    await file.close()
  }
}

async function cacheSize(path) {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) fail('unsafe_cache')
    total += entry.isDirectory() ? await cacheSize(child) : (await lstat(child)).size
    if (total > MAX_CACHE_BYTES) fail('cache_budget_exceeded')
  }
  return total
}

export async function assessCloudflareVulnerabilities({ rootDirectory, outputPath }, dependencies = {}) {
  const root = await realpath(rootDirectory)
  const output = resolve(root, outputPath)
  if (output !== join(root, '.wrangler/shop-evidence/vulnerabilities.json')) fail('unsafe_output')
  await safePath(root, output)
  try {
    await lstat(output)
    fail('output_exists')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const run = dependencies.execute ?? execute
  const paths = [
    'package.json',
    'package-lock.json',
    '.wrangler/shop-evidence/manifest.json',
    '.wrangler/shop-evidence/sbom.cdx.json'
  ]
  const snapshot = async () => Promise.all(paths.map((path) => boundedRead(root, join(root, path))))
  const before = await snapshot()
  const pkg = JSON.parse(before[0].toString('utf8'))
  const lock = JSON.parse(before[1].toString('utf8'))
  if (!object(pkg.engines) || pkg.engines.node !== process.versions.node || typeof pkg.engines.npm !== 'string')
    fail('invalid_toolchain')
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  const verifier = fileURLToPath(new URL('./emit-cloudflare-artifacts.ts', import.meta.url))
  const verify = async () => {
    const result = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        verifier,
        `--root=${root}`,
        `--manifest=${join(root, paths[2])}`,
        `--sbom-input=${join(root, paths[3])}`
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000, maxBuffer: 4096 }
    )
    if (result.status !== 0) fail('artifact_verification_failed')
  }
  await verify()
  const version = await run(process.execPath, [npmCli, '--version'], { cwd: root, timeout: 10_000, maxBuffer: 1024 })
  if (version.status !== 0 || version.stdout.trim() !== pkg.engines.npm) fail('invalid_toolchain')
  const scratch = await mkdtemp(join(dirname(output), '.vulnerability-audit-'))
  try {
    const auditedAt = (dependencies.now ?? (() => new Date().toISOString()))()
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(auditedAt) || !Number.isFinite(Date.parse(auditedAt)))
      fail('invalid_clock')
    const result = await run(
      process.execPath,
      [
        npmCli,
        'audit',
        '--package-lock-only',
        '--json',
        '--audit-level=high',
        '--include=prod',
        '--include=dev',
        '--include=optional',
        '--include=peer',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org',
        '--fetch-retries=0',
        '--fetch-timeout=15000',
        `--userconfig=${join(scratch, 'no-user-config')}`,
        `--globalconfig=${join(scratch, 'no-global-config')}`
      ],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: MAX_REPORT_BYTES,
        budgetDirectory: scratch,
        env: {
          PATH: process.env.PATH,
          npm_config_cache: scratch,
          npm_config_ignore_scripts: 'true',
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_logs_max: '0'
        }
      }
    )
    await cacheSize(scratch)
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_REPORT_BYTES)
      fail('assessment_too_large')
    let report
    try {
      report = JSON.parse(result.stdout)
    } catch {
      fail('invalid_assessment')
    }
    const decision = evaluateNpmVulnerabilities(report, result.status, lock)
    await verify()
    const after = await snapshot()
    if (before.some((bytes, index) => !bytes.equals(after[index]))) fail('artifact_changed')
    const reportBytes = JSON.stringify(canonical(report))
    const evidence = {
      schemaVersion: 1,
      scope: 'lock_supply_chain',
      auditedAt,
      npmVersion: version.stdout.trim(),
      registry: 'https://registry.npmjs.org',
      reproducibility: 'same_recorded_report_and_input_bytes_only',
      policy: { minimumSeverity: 'high', include: ['prod', 'dev', 'optional', 'peer'], exceptions: [] },
      inputs: Object.fromEntries(paths.map((path, index) => [path, sha(before[index])])),
      ...decision,
      reportSha256: sha(reportBytes),
      report
    }
    const bytes = JSON.stringify(canonical(evidence)) + '\n'
    if (Buffer.byteLength(bytes) > MAX_REPORT_BYTES) fail('assessment_too_large')
    await safePath(root, output)
    await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
    return evidence
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const args = new Map()
  for (const value of process.argv.slice(2)) {
    const match = /^--(root|output)=(.+)$/.exec(value)
    if (!match || args.has(match[1])) fail('invalid_arguments')
    args.set(match[1], match[2])
  }
  if (args.size !== 2) fail('invalid_arguments')
  const result = await assessCloudflareVulnerabilities({
    rootDirectory: args.get('root'),
    outputPath: args.get('output')
  })
  process.stdout.write(JSON.stringify({ status: result.status, counts: result.counts }) + '\n')
  if (result.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('cloudflare_vulnerability_assessment_failed\n')
    process.exitCode = 1
  })
}
