import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import Ajv from 'ajv'
import { experimental_readRawConfig } from 'wrangler'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalShopConfig } from '../../scripts/generate-shop-config'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

async function sourceConfig(): Promise<Record<string, unknown>> {
  const { rawConfig } = experimental_readRawConfig({ config: resolve(ROOT, 'wrangler.canary.jsonc') })
  return rawConfig as Record<string, unknown>
}

function binding(source: Record<string, unknown>, path: string): Record<string, unknown> {
  let value: unknown = source
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key]
  return value as Record<string, unknown>
}

describe('local full-shop Cloudflare configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('binds real shop and Nitro artifacts with paths independent of the generated config directory', async () => {
    const source = await sourceConfig()
    const output = createLocalShopConfig(source, ROOT)
    expect(output.main).toBe(resolve(ROOT, 'workers/shop.ts'))
    expect(output.alias).toEqual({ '#neteco/nitro-renderer': resolve(ROOT, '.output-cloudflare/server/index.mjs') })
    expect(output.assets).toEqual({
      directory: resolve(ROOT, '.output-cloudflare/public'),
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none'
    })
    const shop = await readFile(output.main as string, 'utf8')
    expect(shop).toContain("import renderer from '#neteco/nitro-renderer'")
    expect(shop).toContain("import { handleD1CategoryRedirect } from './catalog/category-redirects'")
    expect(shop).toMatch(/createShopIngress\(\s*api,\s*renderer,/)
    expect(shop).toContain('handleD1CategoryRedirect(request, env.DB)')
    expect(shop).toContain('resolveCmsPublicRedirect(request, cmsRuntimeDependencies(env))')
    const generator = await readFile(resolve(ROOT, 'scripts/generate-shop-config.ts'), 'utf8')
    expect(generator).toContain("resolve('.wrangler/shop')")
    expect(generator).toContain('mode: 0o600')
  })

  it('preserves each real Durable Object and Workflow class exported by the shop entrypoint', async () => {
    const source = await sourceConfig()
    const output = createLocalShopConfig(source, ROOT)
    const entrypoint = ts.createSourceFile(
      'shop.ts',
      await readFile(output.main as string, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const exported = entrypoint.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : []
    )
    const objects = output.durable_objects as { bindings: Array<{ name: string; class_name: string }> }
    const workflows = output.workflows as Array<{ binding: string; class_name: string }>
    expect(objects).toEqual(source.durable_objects)
    expect(workflows).toEqual(
      (source.workflows as Record<string, unknown>[]).map((workflow) => ({ ...workflow, remote: false }))
    )
    expect(objects.bindings.map((binding) => binding.name)).toEqual(['COORDINATOR', 'INVENTORY', 'CARTS'])
    for (const binding of [...objects.bindings, ...workflows]) expect(exported).toContain(binding.class_name)
    expect(exported).toEqual(
      expect.arrayContaining(['CanaryCoordinator', 'InventoryCoordinator', 'CartCoordinator', 'CanaryWorkflow'])
    )
  })

  it('preserves platform resources, schema migrations, triggers and policy rather than replacing them', async () => {
    const source = await sourceConfig()
    const snapshot = structuredClone(source)
    const output = createLocalShopConfig(source, ROOT)
    for (const key of [
      'durable_objects',
      'migrations',
      'ratelimits',
      'triggers',
      'compatibility_date',
      'compatibility_flags',
      'secrets'
    ])
      expect(output[key], key).toEqual(source[key])
    const databases = source.d1_databases as Record<string, unknown>[]
    expect(output.d1_databases).toEqual(
      databases.map((binding) => ({
        ...binding,
        remote: false,
        migrations_dir: resolve(ROOT, binding.migrations_dir as string)
      }))
    )
    for (const path of [
      'd1_databases.0',
      'kv_namespaces.0',
      'r2_buckets.0',
      'images',
      'send_email.0',
      'send_email.1',
      'queues.producers.0',
      'workflows.0'
    ])
      expect(binding(output, path).remote, path).toBe(false)
    expect(source).toEqual(snapshot)
    ;(output.queues as { producers: Array<{ queue: string }> }).producers[0]!.queue = 'output-only-change'
    expect(source).toEqual(snapshot)
  })

  it('projects away aliases, unknown variables, environment overrides and remote/process escape hatches', async () => {
    const source = await sourceConfig()
    const marker = 'private-hostile-fixture-value'
    for (const key of [
      'env',
      'services',
      'unsafe',
      'build',
      'dev',
      'define',
      'rules',
      'wasm_modules',
      'text_blobs',
      'data_blobs',
      'pipelines',
      'hyperdrive',
      'dispatch_namespaces',
      'containers',
      'worker_loaders',
      'vpc_services',
      'ai',
      'browser',
      'tail_consumers',
      'assets',
      'route',
      'account_id',
      'alias',
      'custom_process'
    ])
      source[key] = { production: { value: marker, remote: true } }
    const variables = source.vars as Record<string, unknown>
    variables.PUBLIC_CUSTOM_THEME = marker
    variables.UNDECLARED_CREDENTIAL = marker
    variables.PUBLIC_NESTED = { password: marker }
    const snapshot = structuredClone(source)
    const output = createLocalShopConfig(source, ROOT)
    expect(JSON.stringify(output)).not.toContain(marker)
    expect(output.env).toBeUndefined()
    expect(output.services).toBeUndefined()
    expect(output.alias).toEqual({ '#neteco/nitro-renderer': resolve(ROOT, '.output-cloudflare/server/index.mjs') })
    expect(source).toEqual(snapshot)
  })

  it('never inherits public deployment routes, account identity or enabled sensitive features', async () => {
    const source = await sourceConfig()
    source.account_id = 'source-account-placeholder'
    source.workers_dev = true
    source.preview_urls = true
    source.routes = ['neteco.es/*']
    const vars = source.vars as Record<string, string>
    const disabled = [
      'AUTH_ENABLED',
      'ANALYTICS_ENABLED',
      'ANALYTICS_PROJECTION_ENABLED',
      'ANALYTICS_RETENTION_ENABLED',
      'AUTH_EMAIL_ENABLED',
      'MEDIA_ADMIN_ENABLED',
      'MEDIA_PUBLIC_ENABLED',
      'REDSYS_ENABLED',
      'REDSYS_BIZUM_ENABLED',
      'NEWSLETTER_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED'
    ]
    for (const key of disabled) vars[key] = 'true'
    vars.REDSYS_ENVIRONMENT = 'production'
    vars.ANALYTICS_POLICY = '{"reference":"must-not-grant-approval"}'
    vars.REDSYS_MERCHANT_CODE = 'production-merchant'
    vars.REDSYS_TERMINAL = 'production-terminal'
    const output = createLocalShopConfig(source, ROOT)
    expect(output.account_id).toBeUndefined()
    expect(output.$schema).toBeUndefined()
    expect(output.name).toBe('neteco-shop-local')
    expect(output.workers_dev).toBe(false)
    expect(output.preview_urls).toBe(false)
    expect(output.routes).toEqual([])
    for (const key of disabled) expect((output.vars as Record<string, string>)[key], key).toBe('false')
    expect((output.vars as Record<string, string>).ANALYTICS_POLICY).toBe('null')
    expect(output.vars).toMatchObject({ REDSYS_ENVIRONMENT: 'sandbox', REDSYS_MERCHANT_CODE: '', REDSYS_TERMINAL: '' })
  })

  it('keeps public origin, environment and shipping policy coherent with local authoritative values', async () => {
    const source = await sourceConfig()
    const sourceVars = source.vars as Record<string, string>
    sourceVars.APP_ENV = 'production'
    sourceVars.FREE_SHIPPING_THRESHOLD_CENTS = '23100'
    sourceVars.NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS = '1'
    const origins = [
      'AUTH_ORIGIN',
      'PUBLIC_SITE_ORIGIN',
      'MEDIA_ADMIN_ORIGIN',
      'PAYMENT_PUBLIC_BASE_URL',
      'NEWSLETTER_PUBLIC_ORIGIN',
      'NUXT_PUBLIC_BASE_URL'
    ]
    for (const origin of origins) sourceVars[origin] = 'https://neteco.es'
    const vars = createLocalShopConfig(source, ROOT).vars as Record<string, string>
    expect(vars.APP_ENV).toBe('local')
    expect(vars.NUXT_PUBLIC_APP_ENV).toBe(vars.APP_ENV)
    expect(vars.NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS).toBe(vars.FREE_SHIPPING_THRESHOLD_CENTS)
    for (const origin of origins) expect(vars[origin], origin).toBe('https://neteco.invalid')
  })

  it('ignores process credentials and never resolves secret metadata into values', async () => {
    for (const key of ['CLOUDFLARE_API_TOKEN', 'NUXT_SESSION_PASSWORD', 'BEPLY_API_TOKEN'])
      vi.stubEnv(key, 'never-embed-this-test-only-secret')
    const source = await sourceConfig()
    const output = createLocalShopConfig(source, ROOT)
    expect(output.secrets).toEqual(source.secrets)
    expect(JSON.stringify(output)).not.toContain('never-embed-this-test-only-secret')
  })

  it.each([
    'CLOUDFLARE_API_TOKEN',
    'NUXT_SESSION_PASSWORD',
    'AUTH_TOKEN_PEPPER',
    'ANALYTICS_SESSION_PEPPER',
    'BEPLY_API_TOKEN',
    'DATABASE_URL',
    'CUSTOM_SECRET'
  ])('rejects a nonempty credential %s accidentally supplied as a Wrangler variable', async (key) => {
    const source = await sourceConfig()
    if (key === 'CUSTOM_SECRET') (source.secrets as { required: string[] }).required.push(key)
    ;(source.vars as Record<string, string>)[key] = 'private-test-value'
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('cloudflare_configuration_contains_credentials')
  })

  it('permits empty secret placeholders and handles absent public variables deterministically', async () => {
    const source = await sourceConfig()
    ;(source.vars as Record<string, string>).NUXT_SESSION_PASSWORD = ''
    expect((createLocalShopConfig(source, ROOT).vars as Record<string, string>).NUXT_SESSION_PASSWORD).toBeUndefined()
    delete source.vars
    expect(createLocalShopConfig(source, ROOT).vars).toMatchObject({
      APP_ENV: 'local',
      NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS: '0'
    })
  })

  it.each([undefined, 'malformed', [null]])(
    'rejects malformed D1 bindings without writing a configuration',
    async (bindings) => {
      const source = await sourceConfig()
      source.d1_databases = bindings
      expect(() => createLocalShopConfig(source, ROOT)).toThrow('unsafe_cloudflare_binding_contract')
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
  ])('rejects remote:true at %s instead of silently producing a remote-capable config', async (path) => {
    const source = await sourceConfig()
    binding(source, path).remote = true
    const snapshot = structuredClone(source)
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('unsafe_cloudflare_binding_contract')
    expect(source).toEqual(snapshot)
  })

  it.each([
    ['d1_databases.0', 'preview_database_id'],
    ['d1_databases.0', 'database_internal_env'],
    ['kv_namespaces.0', 'preview_id'],
    ['r2_buckets.0', 'local_s3'],
    ['images', 'unknown_binding'],
    ['send_email.0', 'destination_address'],
    ['durable_objects.bindings.0', 'script_name'],
    ['durable_objects.bindings.1', 'environment'],
    ['workflows.0', 'script_name'],
    ['workflows.0', 'limits'],
    ['queues.producers.0', 'service'],
    ['queues.consumers.0', 'unknown_process'],
    ['ratelimits.0.simple', 'secret'],
    ['migrations.0', 'renamed_classes'],
    ['triggers', 'unknown_trigger'],
    ['observability', 'logs']
  ])('rejects unreviewed nested option %s.%s without disclosing its value', async (path, key) => {
    const source = await sourceConfig()
    const marker = 'nested-private-fixture-value'
    binding(source, path)[key] = { value: marker }
    try {
      createLocalShopConfig(source, ROOT)
      expect.fail('hostile nested option was accepted')
    } catch (error) {
      expect((error as Error).message).toBe('unsafe_cloudflare_binding_contract')
      expect((error as Error).message).not.toContain(marker)
    }
  })

  it.each([
    ['d1_databases.0', 'database_id'],
    ['d1_databases.0', 'database_name'],
    ['d1_databases.0', 'migrations_dir'],
    ['kv_namespaces.0', 'id'],
    ['r2_buckets.0', 'bucket_name'],
    ['queues.producers.0', 'queue'],
    ['queues.consumers.0', 'dead_letter_queue'],
    ['workflows.0', 'name'],
    ['workflows.0', 'class_name'],
    ['durable_objects.bindings.0', 'class_name'],
    ['ratelimits.0', 'namespace_id']
  ])('rejects changed local resource contract %s.%s', async (path, key) => {
    const source = await sourceConfig()
    binding(source, path)[key] = 'unreviewed-production-reference'
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('unsafe_cloudflare_binding_contract')
  })

  it.each(['d1_databases', 'kv_namespaces', 'r2_buckets', 'workflows', 'send_email'])(
    'rejects duplicate/additional %s bindings',
    async (key) => {
      const source = await sourceConfig()
      const bindings = source[key] as unknown[]
      bindings.push(structuredClone(bindings[0]))
      expect(() => createLocalShopConfig(source, ROOT)).toThrow('unsafe_cloudflare_binding_contract')
    }
  )

  it('accepts only explicit false remote options and rejects malformed public/secret metadata', async () => {
    const source = await sourceConfig()
    binding(source, 'd1_databases.0').remote = false
    expect(binding(createLocalShopConfig(source, ROOT), 'd1_databases.0').remote).toBe(false)
    source.secrets = { required: ['CUSTOM_SECRET'], values: { CUSTOM_SECRET: 'private-fixture' } }
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('invalid_cloudflare_secret_metadata')
    source.secrets = { required: ['CUSTOM_SECRET'] }
    source.vars = { FREE_SHIPPING_THRESHOLD_CENTS: { credential: 'private-fixture' } }
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('invalid_cloudflare_shipping_threshold')
    source.vars = 'malformed'
    expect(() => createLocalShopConfig(source, ROOT)).toThrow('invalid_cloudflare_variables')
  })

  it('validates the real installed Wrangler schema without generating files or invoking its CLI', async () => {
    const source = await sourceConfig()
    const output = createLocalShopConfig(source, ROOT)
    const schema = JSON.parse(await readFile(resolve(ROOT, 'node_modules/wrangler/config-schema.json'), 'utf8'))
    const validate = new Ajv({ strict: false }).compile({ ...schema, $ref: '#/definitions/RawConfig' })
    expect(validate(output)).toBe(true)
    expect(validate.errors).toBeNull()
  })
})
