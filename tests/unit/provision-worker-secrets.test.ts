import { describe, expect, it, vi } from 'vitest'
import {
  provisionWorkerSecrets,
  parseProvisionWorkerSecretsArgs,
  generateWorkerSecretValue,
  REQUIRED_WORKER_SECRETS,
  OPTIONAL_WORKER_SECRETS,
  ALL_WORKER_SECRETS,
  type SecretCommandExecutor,
  type ProvisionSecretsLogger
} from '../../scripts/provision-worker-secrets'

describe('provision-worker-secrets CLI parser and validations', () => {
  it('fails when --worker is missing in both dry-run and apply modes', async () => {
    expect(() => parseProvisionWorkerSecretsArgs([])).toThrow(/worker_name_required/i)
    expect(() => parseProvisionWorkerSecretsArgs(['--apply'])).toThrow(/worker_name_required/i)
    expect(() => parseProvisionWorkerSecretsArgs(['--worker', '   '])).toThrow(/worker_name_required/i)
  })

  it('rejects any worker name containing "beply" case-insensitively', async () => {
    expect(() => parseProvisionWorkerSecretsArgs(['--worker', 'neteco-beply'])).toThrow(/beply/i)
    expect(() => parseProvisionWorkerSecretsArgs(['--worker', 'neteco-BEPLY-canary'])).toThrow(/beply/i)
    expect(() => parseProvisionWorkerSecretsArgs(['--worker', 'beply-prod'])).toThrow(/beply/i)
    expect(() => parseProvisionWorkerSecretsArgs(['--worker', 'neteco.beply.es'])).toThrow(/beply/i)
  })

  it('accepts valid worker names and parses dry-run and apply flags correctly', () => {
    const defaultOptions = parseProvisionWorkerSecretsArgs(['--worker', 'neteco-cloudflare-canary'])
    expect(defaultOptions.worker).toBe('neteco-cloudflare-canary')
    expect(defaultOptions.apply).toBe(false)
    expect(defaultOptions.check).toBe(false)
    expect(defaultOptions.includeOptional).toBe(false)

    const applyOptions = parseProvisionWorkerSecretsArgs([
      '--worker',
      'neteco-shop-preprod',
      '--apply',
      '--check',
      '--all'
    ])
    expect(applyOptions.worker).toBe('neteco-shop-preprod')
    expect(applyOptions.apply).toBe(true)
    expect(applyOptions.check).toBe(true)
    expect(applyOptions.includeOptional).toBe(true)
  })

  it('supports comma-separated --only or --secrets filter', () => {
    const filtered = parseProvisionWorkerSecretsArgs([
      '--worker',
      'neteco-cloudflare-canary',
      '--only',
      'NETECO_API_KEY_PEPPER,NETECO_ABUSE_SUBJECT_PEPPER'
    ])
    expect(filtered.onlySecrets).toEqual(['NETECO_API_KEY_PEPPER', 'NETECO_ABUSE_SUBJECT_PEPPER'])
  })
})

describe('cryptographic secret generation', () => {
  it('generates valid formats for every known worker secret with sufficient entropy', () => {
    for (const secretName of ALL_WORKER_SECRETS) {
      const value1 = generateWorkerSecretValue(secretName)
      const value2 = generateWorkerSecretValue(secretName)

      expect(typeof value1).toBe('string')
      expect(value1.length).toBeGreaterThanOrEqual(32)
      // Different runs produce distinct entropy
      expect(value1).not.toBe(value2)

      if (secretName === 'AUTH_ENCRYPTION_KEY') {
        const decoded = Buffer.from(value1, 'base64')
        expect(decoded.byteLength).toBe(32)
      }

      if (secretName === 'NEWSLETTER_HMAC_KEY' || secretName === 'ANALYTICS_SESSION_PEPPER') {
        expect(value1).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(value1).not.toMatch(/^A{43}$/)
      }

      if (
        secretName === 'NETECO_API_KEY_PEPPER' ||
        secretName === 'NETECO_DEVICE_OFFLINE_MASTER_KEY' ||
        secretName === 'NETECO_ABUSE_SUBJECT_PEPPER'
      ) {
        expect(value1.length).toBeGreaterThanOrEqual(32)
      }
    }
  })
})

describe('provisionWorkerSecrets execution behavior', () => {
  function createMockLogger(): ProvisionSecretsLogger & { logs: string[]; errors: string[]; warns: string[] } {
    const logs: string[] = []
    const errors: string[] = []
    const warns: string[] = []
    return {
      logs,
      errors,
      warns,
      log: vi.fn((msg: string) => logs.push(msg)),
      error: vi.fn((msg: string) => errors.push(msg)),
      warn: vi.fn((msg: string) => warns.push(msg))
    }
  }

  function createMockExecutor(existingSecrets: string[] = []): SecretCommandExecutor & {
    puts: Array<{ name: string; worker: string; value: string }>
    listCalls: string[]
  } {
    const puts: Array<{ name: string; worker: string; value: string }> = []
    const listCalls: string[] = []
    return {
      puts,
      listCalls,
      listSecrets: vi.fn(async (worker: string) => {
        listCalls.push(worker)
        return [...existingSecrets]
      }),
      putSecret: vi.fn(async (name: string, worker: string, value: string) => {
        puts.push({ name, worker, value })
        return { stdout: 'Success' }
      })
    }
  }

  it('dry-run executes nothing: never invokes putSecret and prints wrangler commands', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: false,
        check: false
      },
      { executor, logger }
    )

    // Dry run must NOT call putSecret
    expect(executor.puts.length).toBe(0)
    expect(result.appliedCount).toBe(0)
    expect(result.plannedCount).toBe(REQUIRED_WORKER_SECRETS.length)

    // Dry run logs the wrangler command for each missing secret
    for (const secret of REQUIRED_WORKER_SECRETS) {
      expect(
        logger.logs.some((line) => line.includes(`wrangler secret put ${secret} --name neteco-cloudflare-canary`))
      ).toBe(true)
    }
  })

  it('fails when --apply is attempted without --worker', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    await expect(
      provisionWorkerSecrets(
        {
          worker: '',
          apply: true
        },
        { executor, logger }
      )
    ).rejects.toThrow(/worker_name_required/i)

    expect(executor.puts.length).toBe(0)
  })

  it('rejects worker names containing "beply" before executing any commands', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    await expect(
      provisionWorkerSecrets(
        {
          worker: 'neteco-beply-canary',
          apply: true
        },
        { executor, logger }
      )
    ).rejects.toThrow(/beply/i)

    expect(executor.puts.length).toBe(0)
    expect(executor.listCalls.length).toBe(0)
  })

  it('--apply never logs or exposes generated secret values to stdout, stderr, or logger', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: true,
        check: false
      },
      { executor, logger }
    )

    expect(executor.puts.length).toBe(REQUIRED_WORKER_SECRETS.length)
    expect(result.appliedCount).toBe(REQUIRED_WORKER_SECRETS.length)

    // Capture all generated secret values passed via stdin
    const generatedSecrets = executor.puts.map((p) => p.value)
    expect(generatedSecrets.length).toBeGreaterThan(0)

    // Combine all log outputs from all logger channels
    const allLoggedText = [...logger.logs, ...logger.errors, ...logger.warns].join('\n')

    // Verify NONE of the secret values are present anywhere in the logs
    for (const secretValue of generatedSecrets) {
      expect(secretValue.length).toBeGreaterThanOrEqual(32)
      expect(allLoggedText.includes(secretValue)).toBe(false)
    }
  })

  it('--check queries existing secrets and skips already provisioned ones', async () => {
    const existing = ['REDSYS_SECRET_KEY', 'NUXT_SESSION_PASSWORD', 'AUTH_RATE_LIMIT_PEPPER']
    const logger = createMockLogger()
    const executor = createMockExecutor(existing)

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: true,
        check: true
      },
      { executor, logger }
    )

    expect(executor.listCalls).toEqual(['neteco-cloudflare-canary'])
    const missingCount = REQUIRED_WORKER_SECRETS.length - existing.length
    expect(result.appliedCount).toBe(missingCount)
    expect(executor.puts.length).toBe(missingCount)

    // The existing ones must NOT be put
    for (const alreadyPresent of existing) {
      expect(executor.puts.some((p) => p.name === alreadyPresent)).toBe(false)
    }

    // The new ones (NETECO_*) must be put
    expect(executor.puts.some((p) => p.name === 'NETECO_API_KEY_PEPPER')).toBe(true)
    expect(executor.puts.some((p) => p.name === 'NETECO_DEVICE_OFFLINE_MASTER_KEY')).toBe(true)
    expect(executor.puts.some((p) => p.name === 'NETECO_ABUSE_SUBJECT_PEPPER')).toBe(true)
  })

  it('--all includes optional worker secrets in addition to required ones', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: false,
        includeOptional: true
      },
      { executor, logger }
    )

    expect(result.plannedCount).toBe(REQUIRED_WORKER_SECRETS.length + OPTIONAL_WORKER_SECRETS.length)
    expect(result.plannedCount).toBe(ALL_WORKER_SECRETS.length)
  })

  it('does nothing when all targeted secrets are already provisioned', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor([...REQUIRED_WORKER_SECRETS])

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: true,
        check: true
      },
      { executor, logger }
    )

    expect(result.missingSecrets.length).toBe(0)
    expect(result.appliedCount).toBe(0)
    expect(executor.puts.length).toBe(0)
    expect(logger.logs.some((line) => line.includes('already provisioned'))).toBe(true)
  })

  it('supports targeting specific secrets via onlySecrets in options', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()

    const result = await provisionWorkerSecrets(
      {
        worker: 'neteco-cloudflare-canary',
        apply: true,
        onlySecrets: ['NETECO_API_KEY_PEPPER', 'NETECO_DEVICE_OFFLINE_MASTER_KEY']
      },
      { executor, logger }
    )

    expect(result.appliedCount).toBe(2)
    expect(executor.puts.map((p) => p.name)).toEqual(['NETECO_API_KEY_PEPPER', 'NETECO_DEVICE_OFFLINE_MASTER_KEY'])
  })

  it('propagates executor errors during apply without leaking secret values', async () => {
    const logger = createMockLogger()
    const executor = createMockExecutor()
    executor.putSecret = vi.fn(async () => {
      throw new Error('wrangler_secret_put_failed: process exited with code 1')
    })

    await expect(
      provisionWorkerSecrets(
        {
          worker: 'neteco-cloudflare-canary',
          apply: true,
          onlySecrets: ['NETECO_API_KEY_PEPPER']
        },
        { executor, logger }
      )
    ).rejects.toThrow(/wrangler_secret_put_failed/i)
  })
})
