import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import Ajv from 'ajv'
import { experimental_readRawConfig } from 'wrangler'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreprodConfig } from '../../scripts/cloudflare-preprod'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPOSITORY_GUARD = [
  'test -n "$NETECO_GITHUB_REPOSITORY"',
  'test "$GITHUB_REPOSITORY" = "$NETECO_GITHUB_REPOSITORY"',
  'test "${GITHUB_REPOSITORY,,}" != \'publicher0/neteco-shop\''
].join('\n')

interface Step {
  name?: string
  shell?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
}
interface Job {
  if?: string
  environment?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  strategy?: { 'fail-fast'?: boolean; matrix: { audit: string[] } }
  steps: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job>
}
interface WranglerConfig {
  vars: Record<string, string>
  send_email: { name: string; allowed_sender_addresses: string[] }[]
}

async function text(path: string): Promise<string> {
  return readFile(resolve(ROOT, path), 'utf8')
}
async function workflow(name: string): Promise<Workflow> {
  return parse(await text(`.github/workflows/${name}.yml`)) as Workflow
}
async function jsonc<T>(path: string): Promise<T> {
  const parsed = ts.parseConfigFileTextToJson(path, await text(path))
  expect(parsed.error, `invalid JSONC in ${path}`).toBeUndefined()
  return parsed.config as T
}
function readOnlyPermissions(permissions: Record<string, string> | undefined) {
  if (!permissions) return
  for (const permission of Object.values(permissions)) expect(['read', 'none']).toContain(permission)
}

function canarySource(): Record<string, unknown> {
  return experimental_readRawConfig({ config: resolve(ROOT, 'wrangler.canary.jsonc') }).rawConfig as Record<
    string,
    unknown
  >
}

function resources() {
  return new Map([
    ['d1', { name: 'neteco-preprod', uuid: '11111111-1111-1111-1111-111111111111' }],
    ['kv', { title: 'neteco-preprod-cache', id: '11111111111111111111111111111111' }],
    ['r2', { name: 'neteco-preprod-media' }],
    ['queue', { queue_name: 'neteco-preprod-jobs' }],
    ['dlq', { queue_name: 'neteco-preprod-jobs-dlq' }]
  ])
}

function config(source = canarySource()) {
  return createPreprodConfig(source, ROOT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resources())
}

function nested(source: Record<string, unknown>, path: string): Record<string, unknown> {
  let value: unknown = source
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key]
  return value as Record<string, unknown>
}

describe('pure isolated Cloudflare preproduction projection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses only the exact resolved isolated resources and schema-supported nonremote bindings', async () => {
    const source = canarySource()
    const snapshot = structuredClone(source)
    const output = config(source)
    expect(output.name).toBe('neteco-shop-preprod')
    expect(output.main).toBe('../../workers/canary.ts')
    expect(output.d1_databases).toEqual([
      {
        binding: 'DB',
        database_name: 'neteco-preprod',
        database_id: resources().get('d1')!.uuid,
        migrations_dir: '../../db/d1/migrations',
        remote: false
      }
    ])
    expect(output.kv_namespaces).toEqual([{ binding: 'CACHE', id: resources().get('kv')!.id, remote: false }])
    expect(output.r2_buckets).toEqual([
      { binding: 'MEDIA', bucket_name: 'neteco-preprod-media', jurisdiction: 'eu', remote: false }
    ])
    expect(nested(output, 'queues.producers.0')).toEqual({
      binding: 'ASYNC_JOBS',
      queue: 'neteco-preprod-jobs',
      remote: false
    })
    expect(nested(output, 'queues.consumers.0').dead_letter_queue).toBe('neteco-preprod-jobs-dlq')
    expect(output.workflows).toEqual([
      { name: 'neteco-preprod-catalog', binding: 'CATALOG_WORKFLOW', class_name: 'CanaryWorkflow' }
    ])
    expect((output.ratelimits as { namespace_id: string }[]).map((binding) => binding.namespace_id)).toEqual([
      '9706001',
      '9706002',
      '9706003',
      '9706004'
    ])
    expect(output.durable_objects).toEqual(source.durable_objects)
    expect(output.migrations).toEqual(source.migrations)
    expect(output.triggers).toEqual(source.triggers)
    for (const path of ['images', 'send_email.0', 'send_email.1']) expect(nested(output, path).remote).toBe(false)
    const schema = JSON.parse(await text('node_modules/wrangler/config-schema.json'))
    const validate = new Ajv({ strict: false }).compile({ ...schema, $ref: '#/definitions/RawConfig' })
    expect(validate(output)).toBe(true)
    expect(validate.errors).toBeNull()
    nested(output, 'durable_objects.bindings.0').class_name = 'output-only-change'
    expect(source).toEqual(snapshot)
  })

  it('discards production env, account, routes, services, aliases and process additions without calling APIs', () => {
    const source = canarySource()
    const marker = 'private-production-fixture'
    for (const key of ['env', 'account_id', 'routes', 'route', 'services', 'build', 'dev', 'unsafe', 'alias', 'define'])
      source[key] = { production: { vars: { PASSWORD: marker }, remote: true } }
    const fetch = vi.spyOn(globalThis, 'fetch')
    const output = config(source)
    expect(JSON.stringify(output)).not.toContain(marker)
    expect(output.account_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(output.routes).toEqual([])
    expect(output.workers_dev).toBe(false)
    expect(output.preview_urls).toBe(false)
    for (const key of ['env', 'route', 'services', 'build', 'dev', 'unsafe', 'alias', 'define'])
      expect(output[key], key).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hard-disables every sensitive flag and resets production provider details and public origins', () => {
    const source = canarySource()
    const variables = source.vars as Record<string, string>
    for (const key of Object.keys(variables)) if (key.endsWith('_ENABLED')) variables[key] = 'true'
    variables.REDSYS_ENVIRONMENT = 'production'
    variables.REDSYS_MERCHANT_CODE = 'production-fixture'
    variables.REDSYS_TERMINAL = 'production-fixture'
    variables.FREE_SHIPPING_THRESHOLD_CENTS = '23100'
    variables.UNKNOWN_PROVIDER_CREDENTIAL = 'never-embed-test-value'
    const output = config(source).vars as Record<string, string>
    for (const flag of [
      'AUTH_ENABLED',
      'AUTH_EMAIL_ENABLED',
      'MEDIA_ADMIN_ENABLED',
      'MEDIA_PUBLIC_ENABLED',
      'REDSYS_ENABLED',
      'REDSYS_BIZUM_ENABLED',
      'NEWSLETTER_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED'
    ])
      expect(output[flag], flag).toBe('false')
    expect(output.REDSYS_ENVIRONMENT).toBe('sandbox')
    expect(output.REDSYS_MERCHANT_CODE).toBe('')
    expect(output.REDSYS_TERMINAL).toBe('')
    expect(output.UNKNOWN_PROVIDER_CREDENTIAL).toBeUndefined()
    expect(output.APP_ENV).toBe('preprod')
    expect(output.NUXT_PUBLIC_APP_ENV).toBe(output.APP_ENV)
    expect(output.NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS).toBe(output.FREE_SHIPPING_THRESHOLD_CENTS)
    for (const origin of [
      'AUTH_ORIGIN',
      'PUBLIC_SITE_ORIGIN',
      'MEDIA_ADMIN_ORIGIN',
      'PAYMENT_PUBLIC_BASE_URL',
      'NEWSLETTER_PUBLIC_ORIGIN',
      'NUXT_PUBLIC_BASE_URL'
    ])
      expect(output[origin], origin).toBe('https://preprod.neteco.es')
  })

  it.each(['CLOUDFLARE_API_TOKEN', 'NUXT_SESSION_PASSWORD', 'AUTH_TOKEN_PEPPER', 'MEDIA_SCAN_SECRET', 'CUSTOM_SECRET'])(
    'rejects nonempty credential %s in vars without incorporating process credentials',
    (name) => {
      const source = canarySource()
      vi.stubEnv('CLOUDFLARE_API_TOKEN', 'never-embed-process-value')
      expect(JSON.stringify(config(source))).not.toContain('never-embed-process-value')
      if (name === 'CUSTOM_SECRET') (source.secrets as { required: string[] }).required.push(name)
      ;(source.vars as Record<string, string>)[name] = 'never-embed-test-value'
      expect(() => config(source)).toThrow('cloudflare_configuration_contains_credentials')
    }
  )

  it.each([
    'd1_databases.0',
    'kv_namespaces.0',
    'r2_buckets.0',
    'images',
    'send_email.0',
    'queues.producers.0',
    'workflows.0'
  ])('rejects remote source bindings at %s instead of inheriting them into preprod', (path) => {
    const source = canarySource()
    nested(source, path).remote = true
    expect(() => config(source)).toThrow('unsafe_cloudflare_binding_contract')
  })

  it.each([
    ['d1_databases.0', 'preview_database_id'],
    ['r2_buckets.0', 'local_s3'],
    ['durable_objects.bindings.0', 'script_name'],
    ['durable_objects.bindings.0', 'environment'],
    ['workflows.0', 'script_name'],
    ['images', 'credentials'],
    ['queues.producers.0', 'service'],
    ['queues.consumers.0', 'custom_process'],
    ['send_email.0', 'destination_address']
  ])('rejects nested escape fields %s.%s', (path, key) => {
    const source = canarySource()
    nested(source, path)[key] = 'unreviewed-fixture'
    expect(() => config(source)).toThrow('unsafe_cloudflare_binding_contract')
  })

  it.each(['d1', 'kv', 'r2', 'queue', 'dlq'])(
    'requires the exact resolved %s resource and rejects missing ones',
    (kind) => {
      const resolved = resources()
      resolved.delete(kind)
      expect(() => createPreprodConfig(canarySource(), ROOT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resolved)).toThrow(
        'invalid_preprod_resource_contract'
      )
      resolved.set(kind, { name: 'neteco-production' })
      expect(() => createPreprodConfig(canarySource(), ROOT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resolved)).toThrow(
        'invalid_preprod_resource_contract'
      )
    }
  )

  it.each(['malformed', '------------------------------------', '00000000-0000-0000-0000-000000000000'])(
    'rejects invalid or local-placeholder resolved D1 identifiers',
    (uuid) => {
      const resolved = resources()
      resolved.set('d1', { name: 'neteco-preprod', uuid })
      expect(() => createPreprodConfig(canarySource(), ROOT, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resolved)).toThrow(
        'invalid_resource_identifier'
      )
    }
  )

  it('retains CLI read-only defaults, explicit creation and guarded config writes without running the CLI', async () => {
    const script = await text('scripts/cloudflare-preprod.ts')
    expect(script).toContain("const apply = process.argv.includes('--apply')")
    expect(script).toContain("const generate = apply || process.argv.includes('--generate')")
    expect(script).toContain('if (!resource && apply)')
    expect(script).toContain("api(`${accountPath}${specification.path}`, 'POST', specification.body, headers)")
    expect(script).toContain('if (generate)')
    expect(script).toContain('mode: 0o600')
    expect(script).toContain('fileURLToPath(import.meta.url) === resolve(process.argv[1])')
    expect(script).not.toMatch(/['"](?:DELETE|PUT|PATCH)['"]|exec\(|spawn\(|wrangler\s+deploy/)
    const fetch = vi.spyOn(globalThis, 'fetch')
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'invalid-test-account')
    await import('../../scripts/cloudflare-preprod')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('local Cloudflare preproduction configuration invariants', () => {
  it('requires explicit dispatch from main and protects every job with the preprod environment', async () => {
    const preprod = await workflow('cloudflare-preprod')
    expect(Object.keys(preprod.on)).toEqual(['workflow_dispatch'])
    expect(Object.keys(preprod.jobs).length).toBeGreaterThan(0)
    for (const job of Object.values(preprod.jobs)) {
      expect(job.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()).toBe("github.ref == 'refs/heads/main'")
      expect(job.environment).toBe('preprod')
    }
  })

  it('retains read-only GitHub permissions and exposes credentials only to resource resolution', async () => {
    const preprod = await workflow('cloudflare-preprod')
    expect(preprod.permissions.contents).toBe('read')
    readOnlyPermissions(preprod.permissions)
    expect(preprod.env).toEqual({ NETECO_GITHUB_REPOSITORY: '${{ vars.NETECO_GITHUB_REPOSITORY }}' })
    for (const job of Object.values(preprod.jobs)) {
      readOnlyPermissions(job.permissions)
      expect(job.env).toBeUndefined()
      const credentialSteps = job.steps.filter((step) =>
        Object.values(step.env ?? {}).some((value) => value.includes('secrets.'))
      )
      expect(credentialSteps).toHaveLength(1)
      expect(credentialSteps[0]!.run).toBe('npm run cloudflare:preprod:prepare')
      expect(Object.keys(credentialSteps[0]!.env!).sort()).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
    }
  })

  it('runs read-only preparation and a dry build, never deployment, upload or resource creation', async () => {
    const preprod = await workflow('cloudflare-preprod')
    const packageJson = await jsonc<{ scripts: Record<string, string> }>('package.json')
    const steps = Object.values(preprod.jobs).flatMap((job) => job.steps)
    const commands = steps.flatMap((step) => (step.run ? [step.run] : []))
    const prepare = commands.filter((command) => command === 'npm run cloudflare:preprod:prepare')
    expect(prepare).toHaveLength(1)
    // Resolve the invoked package script: the harmless workflow command must
    // not conceal --apply, a remote migration or an upload in an npm alias.
    expect(packageJson.scripts['cloudflare:preprod:prepare'].trim()).toBe(
      'tsx scripts/cloudflare-preprod.ts --generate'
    )
    const build = commands.filter((command) => /\bwrangler\s+deploy\b/.test(command))
    expect(build).toHaveLength(1)
    expect(build[0]).toMatch(/\s--dry-run(?:\s|$)/)
    expect(build[0]).toContain('--config .wrangler/preprod/wrangler.json')
    expect(build[0]).toContain('--outdir .wrangler/preprod-build')
    const guard = steps.filter((step) => step.name === 'Verify approved Neteco repository')
    expect(guard).toHaveLength(1)
    expect(steps[0]).toBe(guard[0])
    expect(guard[0]!.shell).toBe('bash')
    expect(guard[0]!.run?.trim()).toBe(REPOSITORY_GUARD)
    expect(guard[0]!.env).toBeUndefined()
    expect(commands.filter((command) => command === 'node scripts/storage-preflight.ts')).toHaveLength(1)
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/)
      if (!step.run) continue
      // Only the exact, separately executed repository guard may be multiline.
      // It cannot introduce credentials or hide a mutating command.
      if (step === guard[0]) continue
      expect(step.run).not.toMatch(/--apply\b|--remote\b|\bupload\b|\bpublish\b|\bmigrations?\b|[;\n]|\|\||&&/)
      if (step.run === 'npm ci') continue
      if (step.run === 'node scripts/storage-preflight.ts') continue
      if (step.run.startsWith('npm run ')) {
        const script = step.run.slice('npm run '.length)
        expect(['cloudflare:preprod:prepare', 'typecheck:worker', 'test:worker']).toContain(script)
        expect(packageJson.scripts[script]).not.toMatch(/--apply\b|--remote\b|\bupload\b|\bdeploy\b|\bpublish\b/)
      } else {
        // Apart from the exact guard and host-storage gate above, the only
        // non-npm command is this dry-run build; no arbitrary shell exceptions.
        expect(step.run).toBe(build[0])
      }
    }
  })

  it.each([
    ['approved own repository', 'devtono/neteco-owned-fixture', 'devtono/neteco-owned-fixture', true],
    ['empty approved variable', '', 'devtono/neteco-owned-fixture', false],
    ['different repository', 'devtono/neteco-owned-fixture', 'another/neteco', false],
    ['upstream even when configured as approved', 'PublicHer0/neteco-shop', 'PublicHer0/neteco-shop', false]
  ] as const)('executes the real repository guard for %s', async (_name, approved, actual, accepted) => {
    const preprod = await workflow('cloudflare-preprod')
    const guard = Object.values(preprod.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.name === 'Verify approved Neteco repository')
    expect(guard).toHaveLength(1)
    expect(guard[0]!.shell).toBe('bash')
    // Match Actions' explicit bash fail-fast/pipefail semantics. No inherited
    // credentials, executable commands, network or repository operation.
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard[0]!.run!], {
      env: { NETECO_GITHUB_REPOSITORY: approved, GITHUB_REPOSITORY: actual },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status === 0).toBe(accepted)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('keeps all five D1 audits as independent non-fail-fast matrix executions', async () => {
    const compatibility = await workflow('cloudflare-compat')
    const audits = compatibility.jobs['d1-audits']!
    expect(audits.strategy?.['fail-fast']).toBe(false)
    const matrix = audits.strategy!.matrix.audit
    expect([...matrix].sort()).toEqual(['cart', 'catalog', 'checkout', 'inventory', 'media'])
    expect(new Set(matrix).size).toBe(5)
    const matrixCommands = audits.steps.filter((step) => step.run?.includes('${{ matrix.audit }}'))
    expect(matrixCommands).toHaveLength(1)
    expect(matrixCommands[0]!.run).toBe('npx tsx scripts/audit-d1-${{ matrix.audit }}.ts')
    for (const audit of matrix) {
      expect(await text(`scripts/audit-d1-${audit}.ts`)).not.toHaveLength(0)
    }
    expect(audits.steps.some((step) => step.run === 'npm run cloudflare:check')).toBe(false)
    const worker = compatibility.jobs['worker-canary']!
    expect(worker.steps.some((step) => step.run === 'npm run typecheck:worker')).toBe(true)
    expect(worker.steps.some((step) => step.run === 'npm run test:worker')).toBe(true)
    expect(worker.steps.some((step) => step.run === 'npm run audit:worker-bundle')).toBe(true)
    expect(worker.steps.some((step) => step.run?.includes('audit-d1-'))).toBe(false)
  })

  it('defaults sensitive features off and authorises distinct transactional and marketing senders', async () => {
    const config = await jsonc<WranglerConfig>('wrangler.canary.jsonc')
    for (const flag of [
      'AUTH_ENABLED',
      'MEDIA_ADMIN_ENABLED',
      'REDSYS_ENABLED',
      'REDSYS_BIZUM_ENABLED',
      'NEWSLETTER_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED'
    ])
      expect(config.vars[flag], flag).toBe('false')
    const transactional = config.send_email.filter((binding) => binding.name === 'EMAIL')
    const marketing = config.send_email.filter((binding) => binding.name === 'NEWSLETTER_EMAIL')
    expect(transactional).toHaveLength(1)
    expect(marketing).toHaveLength(1)
    expect(transactional[0]!.allowed_sender_addresses).toEqual([config.vars.TRANSACTIONAL_EMAIL_FROM])
    expect(marketing[0]!.allowed_sender_addresses).toEqual([config.vars.NEWSLETTER_EMAIL_FROM])
    expect(config.vars.TRANSACTIONAL_EMAIL_FROM).toMatch(/^[a-z0-9._%+-]+@neteco\.es$/)
    expect(config.vars.NEWSLETTER_EMAIL_FROM).toMatch(/^[a-z0-9._%+-]+@neteco\.es$/)
    expect(config.vars.TRANSACTIONAL_EMAIL_FROM).not.toBe(config.vars.NEWSLETTER_EMAIL_FROM)
  })

  it('includes every existing Worker module in the dedicated no-emit typecheck', async () => {
    const config = await jsonc<{ include: string[]; exclude: string[]; compilerOptions: { noEmit: boolean } }>(
      'tsconfig.worker.json'
    )
    const packageJson = await jsonc<{ scripts: Record<string, string> }>('package.json')
    expect(config.compilerOptions.noEmit).toBe(true)
    expect(packageJson.scripts['typecheck:worker']).toBe('tsc --noEmit -p tsconfig.worker.json')
    const allWorkers = ts.sys.readDirectory(ROOT, ['.ts'], ['node_modules'], ['workers/**/*.ts']).sort()
    const included = new Set(ts.sys.readDirectory(ROOT, ['.ts'], config.exclude, config.include))
    expect(allWorkers.length).toBeGreaterThan(0)
    expect(allWorkers.filter((path) => !included.has(path))).toEqual([])
    expect(included.has(resolve(ROOT, 'worker-configuration.d.ts'))).toBe(true)
  })
})
