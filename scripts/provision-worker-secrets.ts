import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * Core required secrets declared in wrangler.canary.jsonc plus the
 * new security control secrets for this batch.
 */
export const REQUIRED_WORKER_SECRETS = [
  'REDSYS_SECRET_KEY',
  'NUXT_SESSION_PASSWORD',
  'AUTH_RATE_LIMIT_PEPPER',
  'AUTH_TOKEN_PEPPER',
  'AUTH_ENCRYPTION_KEY',
  'NEWSLETTER_HMAC_KEY',
  'MEDIA_SCAN_SECRET',
  // New in this batch (Security Controls / Devices / Abuse)
  'NETECO_API_KEY_PEPPER',
  'NETECO_DEVICE_OFFLINE_MASTER_KEY',
  'NETECO_ABUSE_SUBJECT_PEPPER'
] as const

/**
 * Operational / feature secrets used across workers/runtime/* and integrations.
 */
export const OPTIONAL_WORKER_SECRETS = [
  'CMS_PREVIEW_SECRET',
  'ANALYTICS_SESSION_PEPPER',
  'BEPLY_API_TOKEN',
  'NEWSLETTER_FEEDBACK_SECRET',
  'SUPPORT_SCAN_SECRET',
  'SUPPORT_TURNSTILE_SECRET'
] as const

export const ALL_WORKER_SECRETS = [...REQUIRED_WORKER_SECRETS, ...OPTIONAL_WORKER_SECRETS] as const

export type WorkerSecretName = (typeof ALL_WORKER_SECRETS)[number] | (string & {})

export interface ProvisionWorkerSecretsOptions {
  worker: string
  apply?: boolean
  check?: boolean
  includeOptional?: boolean
  onlySecrets?: string[]
}

export interface SecretCommandExecutor {
  listSecrets?: (worker: string) => Promise<string[]>
  putSecret?: (name: string, worker: string, secretValue: string) => Promise<{ stdout?: string; stderr?: string }>
}

export interface ProvisionSecretsLogger {
  log: (message: string) => void
  error: (message: string) => void
  warn: (message: string) => void
}

export interface ProvisionSecretsDependencies {
  executor?: SecretCommandExecutor
  logger?: ProvisionSecretsLogger
  generator?: (secretName: string) => string
}

export interface ProvisionResult {
  worker: string
  plannedCount: number
  appliedCount: number
  targetSecrets: string[]
  missingSecrets: string[]
  existingSecrets: string[]
}

/**
 * Generates cryptographically secure random values matching each secret's
 * runtime length, entropy, and encoding constraints.
 */
export function generateWorkerSecretValue(secretName: string): string {
  switch (secretName) {
    case 'AUTH_ENCRYPTION_KEY':
    case 'REDSYS_SECRET_KEY':
      // 32-byte key base64-encoded (44 characters, exactly 32 bytes decoded)
      return randomBytes(32).toString('base64')

    case 'NEWSLETTER_HMAC_KEY':
    case 'ANALYTICS_SESSION_PEPPER':
      // Exactly 32 bytes base64url (43 characters without padding)
      return randomBytes(32).toString('base64url')

    case 'NETECO_API_KEY_PEPPER':
    case 'NETECO_DEVICE_OFFLINE_MASTER_KEY':
    case 'NETECO_ABUSE_SUBJECT_PEPPER':
    case 'NEWSLETTER_FEEDBACK_SECRET':
    case 'SUPPORT_SCAN_SECRET':
    case 'SUPPORT_TURNSTILE_SECRET':
    case 'BEPLY_API_TOKEN':
      // 32 bytes base64url (43 characters, >= 32 chars)
      return randomBytes(32).toString('base64url')

    case 'NUXT_SESSION_PASSWORD':
    case 'AUTH_RATE_LIMIT_PEPPER':
    case 'AUTH_TOKEN_PEPPER':
    case 'MEDIA_SCAN_SECRET':
    case 'CMS_PREVIEW_SECRET':
      // 48 bytes hex (96 characters, high entropy)
      return randomBytes(48).toString('hex')

    default:
      return randomBytes(32).toString('base64url')
  }
}

/**
 * Validates the target worker name.
 * Strictly rejects any worker name containing "beply" to protect production.
 */
export function validateWorkerName(worker: string | undefined | null): string {
  if (!worker || typeof worker !== 'string' || worker.trim() === '') {
    throw new Error('worker_name_required: --worker <name> must be explicitly specified')
  }
  const normalized = worker.trim()
  if (/beply/i.test(normalized)) {
    throw new Error(
      `target_worker_forbidden: worker name "${normalized}" contains "beply". Operating against Beply production is strictly prohibited.`
    )
  }
  return normalized
}

/**
 * Parses CLI arguments.
 */
export function parseProvisionWorkerSecretsArgs(args: string[]): ProvisionWorkerSecretsOptions {
  let worker: string | undefined
  let apply = false
  let check = false
  let includeOptional = false
  let onlySecrets: string[] | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--worker' && i + 1 < args.length) {
      worker = args[++i]
    } else if (arg.startsWith('--worker=')) {
      worker = arg.slice('--worker='.length)
    } else if (arg === '--apply') {
      apply = true
    } else if (arg === '--dry-run') {
      apply = false
    } else if (arg === '--check') {
      check = true
    } else if (arg === '--all' || arg === '--include-optional') {
      includeOptional = true
    } else if ((arg === '--only' || arg === '--secrets') && i + 1 < args.length) {
      onlySecrets = args[++i]!.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--only=') || arg.startsWith('--secrets=')) {
      const value = arg.split('=')[1] ?? ''
      onlySecrets = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }

  const validatedWorker = validateWorkerName(worker)
  return {
    worker: validatedWorker,
    apply,
    check,
    includeOptional,
    onlySecrets
  }
}

/**
 * Default child_process executor calling wrangler CLI without exposing secret values.
 */
export function createDefaultExecutor(): SecretCommandExecutor {
  return {
    async listSecrets(worker: string): Promise<string[]> {
      return new Promise((resolvePromise, reject) => {
        const proc = spawn('npx', ['wrangler', 'secret', 'list', '--name', worker], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => {
          stdout += d.toString('utf8')
        })
        proc.stderr.on('data', (d) => {
          stderr += d.toString('utf8')
        })
        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`wrangler_secret_list_failed (exit code ${code}): ${stderr}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout) as Array<{ name?: string }>
            if (Array.isArray(parsed)) {
              resolvePromise(parsed.map((item) => item.name).filter((n): n is string => Boolean(n)))
              return
            }
          } catch {
            // If output is text rather than JSON
            const lines = stdout
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
            resolvePromise(lines)
            return
          }
          resolvePromise([])
        })
        proc.on('error', reject)
      })
    },

    async putSecret(name: string, worker: string, secretValue: string): Promise<{ stdout?: string; stderr?: string }> {
      return new Promise((resolvePromise, reject) => {
        const proc = spawn('npx', ['wrangler', 'secret', 'put', name, '--name', worker], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d) => {
          stdout += d.toString('utf8')
        })
        proc.stderr.on('data', (d) => {
          stderr += d.toString('utf8')
        })
        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`wrangler_secret_put_failed for ${name} (exit code ${code})`))
            return
          }
          resolvePromise({ stdout, stderr })
        })
        proc.on('error', reject)

        // Write secret directly into stdin and close the stream.
        // Secret is never passed via command line flags or written to filesystem.
        proc.stdin.write(secretValue)
        proc.stdin.end()
      })
    }
  }
}

/**
 * Main provisioning workflow.
 */
export async function provisionWorkerSecrets(
  options: ProvisionWorkerSecretsOptions,
  deps: ProvisionSecretsDependencies = {}
): Promise<ProvisionResult> {
  const worker = validateWorkerName(options.worker)
  const isApply = Boolean(options.apply)
  const shouldCheck = Boolean(options.check)
  const logger: ProvisionSecretsLogger = deps.logger ?? {
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
    warn: (msg) => console.warn(msg)
  }
  const executor = deps.executor ?? createDefaultExecutor()
  const generator = deps.generator ?? generateWorkerSecretValue

  // Determine candidate secrets
  let candidateSecrets: string[]
  if (options.onlySecrets && options.onlySecrets.length > 0) {
    candidateSecrets = options.onlySecrets
  } else if (options.includeOptional) {
    candidateSecrets = [...ALL_WORKER_SECRETS]
  } else {
    candidateSecrets = [...REQUIRED_WORKER_SECRETS]
  }

  // If check requested, query remote secrets from worker
  let existingSecrets: string[] = []
  if (shouldCheck && executor.listSecrets) {
    logger.log(`[check] Querying existing secrets for worker "${worker}"...`)
    try {
      existingSecrets = await executor.listSecrets(worker)
      logger.log(`[check] Found ${existingSecrets.length} existing secret(s) on worker.`)
    } catch (error) {
      logger.warn(`[check] Could not retrieve existing secrets list: ${(error as Error).message}`)
    }
  }

  const existingSet = new Set(existingSecrets)
  const missingSecrets = candidateSecrets.filter((s) => !existingSet.has(s))

  logger.log(`Target worker: ${worker}`)
  logger.log(`Mode: ${isApply ? 'APPLY (provisioning secrets)' : 'DRY-RUN (planning commands)'}`)
  logger.log(`Total target secrets: ${candidateSecrets.length}`)
  logger.log(`Secrets to provision: ${missingSecrets.length}`)

  if (missingSecrets.length === 0) {
    logger.log(`All targeted secrets are already provisioned on worker "${worker}". Nothing to do.`)
    return {
      worker,
      plannedCount: 0,
      appliedCount: 0,
      targetSecrets: candidateSecrets,
      missingSecrets: [],
      existingSecrets
    }
  }

  if (!isApply) {
    // DRY-RUN mode: print the wrangler commands without executing or generating secrets
    logger.log('\n--- DRY-RUN PLAN: Commands to run ---')
    for (const secret of missingSecrets) {
      logger.log(`wrangler secret put ${secret} --name ${worker}`)
    }
    logger.log('--- End of DRY-RUN plan (run with --apply to execute) ---\n')

    return {
      worker,
      plannedCount: missingSecrets.length,
      appliedCount: 0,
      targetSecrets: candidateSecrets,
      missingSecrets,
      existingSecrets
    }
  }

  // APPLY mode: generate random secrets and pass via stdin to wrangler
  let appliedCount = 0
  for (const secret of missingSecrets) {
    const value = generator(secret)
    if (!deps.executor?.putSecret && !deps.executor) {
      throw new Error('executor_missing: cannot apply without executor')
    }
    const putFn = deps.executor?.putSecret ?? executor.putSecret
    if (!putFn) {
      throw new Error('executor_put_unsupported')
    }

    await putFn(secret, worker, value)
    appliedCount++
    // Log success without logging the secret value
    logger.log(`[apply] Successfully provisioned secret ${secret} on worker "${worker}".`)
  }

  logger.log(`[apply] Completed: ${appliedCount} secret(s) provisioned on worker "${worker}".`)

  return {
    worker,
    plannedCount: missingSecrets.length,
    appliedCount,
    targetSecrets: candidateSecrets,
    missingSecrets: [],
    existingSecrets: [...existingSecrets, ...missingSecrets]
  }
}

/**
 * CLI entrypoint.
 */
export async function runProvisionCli(): Promise<void> {
  try {
    const options = parseProvisionWorkerSecretsArgs(process.argv.slice(2))
    await provisionWorkerSecrets(options)
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runProvisionCli()
}
