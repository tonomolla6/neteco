import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { chromium } from '@playwright/test'

interface PrivateBrowserServer {
  wsEndpoint(): string
  close(): Promise<void>
}
export interface OraclePreflightEvidence {
  manifest: unknown
  uid: number
  user: string
  machineIdSha256: string
  cwd: string
  temp: string
  workRoot: string
}
interface OracleShopAuditOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  now?: number
  preflight?: () => Promise<OraclePreflightEvidence>
  launchServer?: () => Promise<PrivateBrowserServer>
  execute?: (env: NodeJS.ProcessEnv) => Promise<number>
}

const manifestPath = '/etc/neteco-ci/neteco-shop-runner.json'
function authorizedRepository(env: NodeJS.ProcessEnv): boolean {
  const target = env.NETECO_GITHUB_REPOSITORY
  return (
    typeof target === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(target) &&
    target.toLowerCase() !== 'publicher0/neteco-shop' &&
    target === env.GITHUB_REPOSITORY
  )
}
function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return (
    isAbsolute(root) &&
    isAbsolute(target) &&
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}

async function readPreflight(env: NodeJS.ProcessEnv): Promise<OraclePreflightEvidence> {
  // Every path component is trusted: no symlinks or unprivileged writers.
  for (let path = manifestPath; ; path = dirname(path)) {
    const stat = await lstat(path)
    if (
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (path === manifestPath ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error('Oracle preflight path is not root-managed.')
    if (path === '/') break
  }
  const file = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let manifest: unknown
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 8192)
      throw new Error('Oracle preflight file is not trusted.')
    manifest = JSON.parse(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
  const root = (manifest as { workRoot?: unknown })?.workRoot
  if (typeof root !== 'string' || !isAbsolute(root) || !env.RUNNER_TEMP)
    throw new Error('Oracle preflight paths are missing.')
  const user = userInfo()
  return {
    manifest,
    uid: user.uid,
    user: user.username,
    machineIdSha256: createHash('sha256')
      .update((await readFile('/etc/machine-id', 'utf8')).trim())
      .digest('hex'),
    cwd: await realpath(process.cwd()),
    temp: await realpath(env.RUNNER_TEMP),
    workRoot: await realpath(root)
  }
}

export function validateOraclePreflight(evidence: OraclePreflightEvidence, env: NodeJS.ProcessEnv, now: number): void {
  const m = evidence.manifest as Record<string, unknown> | null
  if (
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    m.version !== 1 ||
    m.oraclePublicIp !== '92.5.3.72' ||
    !authorizedRepository(env) ||
    m.repository !== env.NETECO_GITHUB_REPOSITORY ||
    !Number.isInteger(m.uid) ||
    m.uid === 0 ||
    m.uid !== evidence.uid ||
    m.user !== evidence.user ||
    typeof m.user !== 'string' ||
    !m.user ||
    typeof m.runnerName !== 'string' ||
    !m.runnerName ||
    m.runnerName !== env.RUNNER_NAME ||
    typeof m.machineIdSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(m.machineIdSha256) ||
    m.machineIdSha256 !== evidence.machineIdSha256 ||
    typeof m.workRoot !== 'string' ||
    m.workRoot === '/' ||
    m.workRoot !== evidence.workRoot ||
    !contained(m.workRoot, evidence.cwd) ||
    !contained(m.workRoot, evidence.temp) ||
    typeof m.verifiedAt !== 'string' ||
    typeof m.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(m.verifiedAt)) ||
    !Number.isFinite(Date.parse(m.expiresAt)) ||
    Date.parse(m.verifiedAt) > now ||
    Date.parse(m.expiresAt) <= now ||
    Date.parse(m.expiresAt) <= Date.parse(m.verifiedAt)
  )
    throw new Error('Oracle runner preflight is missing, expired or does not match this host.')
}

function executeAudit(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'audit:shop:local'], { env, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}

/** No hosted fallback. An operator-issued external preflight is mandatory;
 * environment labels alone never authorize a browser on the shared host. */
export async function runOracleShopAudit(options: OracleShopAuditOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'self-hosted' ||
    (options.platform ?? process.platform) !== 'linux' ||
    (options.arch ?? process.arch) !== 'arm64' ||
    env.RUNNER_ARCH !== 'ARM64' ||
    !authorizedRepository(env) ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('Shop CI browser requires the verified self-hosted Oracle ARM64 runner on trusted main events.')
  if (env.PW_TEST_CONNECT_WS_ENDPOINT)
    throw new Error('Shop CI browser must not reuse an externally configured endpoint.')
  validateOraclePreflight(await (options.preflight ?? (() => readPreflight(env)))(), env, options.now ?? Date.now())
  const server = await (options.launchServer ?? (() => chromium.launchServer({ host: '127.0.0.1', port: 0 })))()
  try {
    const endpoint = server.wsEndpoint()
    const url = new URL(endpoint)
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.pathname.length < 2 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /\s/.test(endpoint)
    )
      throw new Error('Shop CI browser did not bind an isolated loopback endpoint.')
    return await (options.execute ?? executeAudit)({
      ...env,
      PW_TEST_CONNECT_WS_ENDPOINT: endpoint,
      NUXT_TELEMETRY_DISABLED: '1',
      WRANGLER_SEND_METRICS: 'false'
    })
  } finally {
    await server.close()
  }
}
