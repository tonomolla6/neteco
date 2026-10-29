import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { experimental_readRawConfig } from 'wrangler'
import { expect, it } from 'vitest'
import { createLocalShopConfig } from '../../scripts/generate-shop-config'
import { createEnvironmentShopConfig } from '../../scripts/lib/cloudflare-environment-config'

const root = fileURLToPath(new URL('../../', import.meta.url))
const executeFile = promisify(execFile)
function environment(kind: 'preprod' | 'production' = 'preprod') {
  const prefix = `neteco-iac-${kind}`
  return {
    environment: kind,
    accountId: '1'.repeat(32),
    zoneId: '2'.repeat(32),
    publicOrigin: kind === 'preprod' ? 'https://preprod.example.test' : 'https://shop.example.test',
    resources: {
      d1: { name: `${prefix}-db`, id: '11111111-2222-4333-8444-555555555555' },
      kv: { name: `${prefix}-cache`, id: '3'.repeat(32) },
      r2: { name: `${prefix}-media`, jurisdiction: 'eu' },
      queue: { name: `${prefix}-jobs` },
      deadLetterQueue: { name: `${prefix}-jobs-dlq` }
    },
    rateLimitNamespaceIds: {
      AUTH_EDGE_LIMIT: '9707001', ADMIN_EDGE_LIMIT: '9707002', CART_EDGE_LIMIT: '9707003', ANALYTICS_EDGE_LIMIT: '9707004'
    }
  }
}
async function source() {
  return experimental_readRawConfig({ config: resolve(root, 'wrangler.canary.jsonc') }).rawConfig as Record<string, unknown>
}

it.each(['preprod', 'production'] as const)('projects %s IaC resources through the real complete shop generator', async (kind) => {
  const original = await source()
  const before = structuredClone(original)
  const contract = environment(kind)
  const config = createEnvironmentShopConfig(original, root, contract)
  const local = createLocalShopConfig(original, root)
  expect(config.name).toBe(`neteco-iac-${kind}-shop`)
  expect(config.account_id).toBe(contract.accountId)
  for (const key of ['main', 'alias', 'assets', 'durable_objects', 'migrations', 'triggers', 'compatibility_date', 'compatibility_flags', 'observability', 'upload_source_maps', 'secrets']) {
    expect(config[key], key).toEqual(local[key])
  }
  expect(config.d1_databases).toEqual([{
    binding: 'DB', database_name: contract.resources.d1.name, database_id: contract.resources.d1.id,
    migrations_dir: resolve(root, 'db/d1/migrations')
  }])
  expect(config.kv_namespaces).toEqual([{ binding: 'CACHE', id: contract.resources.kv.id }])
  expect(config.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: contract.resources.r2.name, jurisdiction: 'eu' }])
  expect(config.queues).toEqual({
    producers: [{ binding: 'ASYNC_JOBS', queue: contract.resources.queue.name }],
    consumers: [{ queue: contract.resources.queue.name, max_batch_size: 10, max_batch_timeout: 5, max_retries: 3, dead_letter_queue: contract.resources.deadLetterQueue.name }]
  })
  expect(config.workflows).toEqual([{
    name: `neteco-iac-${kind}-catalog`, binding: 'CATALOG_WORKFLOW', class_name: 'CanaryWorkflow'
  }])
  expect(config.ratelimits).toEqual((local.ratelimits as { name: keyof typeof contract.rateLimitNamespaceIds }[]).map((binding) => ({
    ...binding, namespace_id: contract.rateLimitNamespaceIds[binding.name]
  })))
  expect(config.routes).toEqual([])
  expect(config.workers_dev).toBe(false)
  expect(config.preview_urls).toBe(false)
  const vars = config.vars as Record<string, string>
  expect(vars.APP_ENV).toBe(kind)
  for (const name of ['AUTH_ORIGIN', 'PUBLIC_SITE_ORIGIN', 'MEDIA_ADMIN_ORIGIN', 'PAYMENT_PUBLIC_BASE_URL', 'NEWSLETTER_PUBLIC_ORIGIN', 'NUXT_PUBLIC_BASE_URL']) {
    expect(vars[name], name).toBe(contract.publicOrigin)
  }
  for (const [name, value] of Object.entries(vars).filter(([name]) => name.endsWith('_ENABLED'))) expect(value, name).toBe('false')
  expect(original).toEqual(before)
  expect(JSON.stringify(config)).not.toContain('neteco-canary-local')
  expect(JSON.stringify(config)).not.toContain('neteco-demo')
  const schema = JSON.parse(await readFile(resolve(root, 'node_modules/wrangler/config-schema.json'), 'utf8'))
  const validate = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true }).compile({
    ...schema, $ref: '#/definitions/RawConfig'
  })
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})

it.each([
  ['missing environment', (input: Record<string, unknown>) => { delete input.environment }],
  ['unknown environment', (input: Record<string, unknown>) => { input.environment = 'demo' }],
  ['implicit production', (input: Record<string, unknown>) => { input.environment = undefined }],
  ['insecure origin', (input: Record<string, unknown>) => { input.publicOrigin = 'http://preprod.example.test' }],
  ['credential origin', (input: Record<string, unknown>) => { input.publicOrigin = 'https://user:password@preprod.example.test' }],
  ['query origin', (input: Record<string, unknown>) => { input.publicOrigin = 'https://preprod.example.test/?token=private' }],
  ['undeclared secret', (input: Record<string, unknown>) => { input.apiToken = 'private-test-marker' }],
  ['source code override', (input: Record<string, unknown>) => { input.main = '/tmp/foreign-worker.js' }]
] as const)('rejects %s instead of generating a deployable configuration', async (_name, corrupt) => {
  const original = await source()
  const contract: Record<string, unknown> = environment()
  corrupt(contract)
  expect(() => createEnvironmentShopConfig(original, root, contract)).toThrow()
})

it.each(['d1', 'kv', 'r2', 'queue', 'deadLetterQueue'] as const)('rejects adopted demo/preprod or cross-environment %s resources', async (resource) => {
  const original = await source()
  for (const name of ['neteco-preprod', 'neteco-preprod-media', 'neteco-demo', `neteco-iac-production-${resource}`]) {
    const contract = environment()
    contract.resources[resource].name = name
    expect(() => createEnvironmentShopConfig(original, root, contract)).toThrow()
  }
})

it('rejects placeholder IDs and colliding rate limit namespaces', async () => {
  const original = await source()
  const database = environment()
  database.resources.d1.id = '00000000-0000-0000-0000-000000000000'
  expect(() => createEnvironmentShopConfig(original, root, database)).toThrow()
  const namespace = environment()
  namespace.resources.kv.id = '0'.repeat(32)
  expect(() => createEnvironmentShopConfig(original, root, namespace)).toThrow()
  const limits = environment()
  limits.rateLimitNamespaceIds.ADMIN_EDGE_LIMIT = limits.rateLimitNamespaceIds.AUTH_EDGE_LIMIT
  expect(() => createEnvironmentShopConfig(original, root, limits)).toThrow()
})

it('does not launder actual source credentials through the environment projection', async () => {
  const original = await source()
  ;(original.vars as Record<string, unknown>).AUTH_TOKEN_PEPPER = 'private-test-marker'
  expect(() => createEnvironmentShopConfig(original, root, environment())).toThrow()
})

it('runs the actual explicit CLI offline and preserves the no-argument local default', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'neteco-iac-cli-'))
  try {
    await copyFile(resolve(root, 'wrangler.canary.jsonc'), resolve(directory, 'wrangler.canary.jsonc'))
    const contractPath = resolve(directory, 'environment.json')
    await writeFile(contractPath, JSON.stringify(environment()), { mode: 0o600 })
    const script = resolve(root, 'scripts/generate-shop-config.ts')
    const tsx = fileURLToPath(import.meta.resolve('tsx'))
    const explicit = await executeFile(process.execPath, ['--import', tsx, script, '--environment-file', contractPath], {
      cwd: directory, timeout: 15000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false', APP_ENV: 'production' }
    })
    expect(explicit.stdout).toContain('generated offline')
    const output = JSON.parse(await readFile(resolve(directory, '.wrangler/environments/preprod/wrangler.json'), 'utf8'))
    expect(output).toMatchObject({ name: 'neteco-iac-preprod-shop', vars: { APP_ENV: 'preprod' } })
    expect(await readdir(resolve(directory, '.wrangler/environments'))).toEqual(['preprod'])
    await executeFile(process.execPath, ['--import', tsx, script], {
      cwd: directory, timeout: 15000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false', APP_ENV: 'production' }
    })
    const local = JSON.parse(await readFile(resolve(directory, '.wrangler/shop/wrangler.json'), 'utf8'))
    expect(local).toMatchObject({ name: 'neteco-shop-local', vars: { APP_ENV: 'local' } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects malformed environment files without echoing their contents or generating configuration', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'neteco-iac-invalid-cli-'))
  try {
    await copyFile(resolve(root, 'wrangler.canary.jsonc'), resolve(directory, 'wrangler.canary.jsonc'))
    const contractPath = resolve(directory, 'environment.json')
    await writeFile(contractPath, '{"token":"do-not-echo-private-marker"', { mode: 0o600 })
    let failure: { stderr?: string } | null = null
    try {
      await executeFile(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')),
        resolve(root, 'scripts/generate-shop-config.ts'), '--environment-file', contractPath], {
        cwd: directory, timeout: 15000, maxBuffer: 65536,
        env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false' }
      })
    } catch (error) {
      failure = error as { stderr?: string }
    }
    expect(failure).not.toBeNull()
    expect(failure?.stderr).toContain('invalid_cloudflare_environment_file')
    expect(failure?.stderr).not.toContain('do-not-echo-private-marker')
    expect(await readdir(directory)).not.toContain('.wrangler')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
