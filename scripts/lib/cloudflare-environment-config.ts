import { cloudflareEnvironmentSchema } from '../../shared/cloudflare-environment'
import { resolve } from 'node:path'
import { createSafePlatformConfig, createSafeVariables } from './cloudflare-config-safety'
import { buildCommitDefinitions } from './build-commit'

/** Existing local projection, shared verbatim by the CLI and environment adapter. */
export function createLocalShopConfig(
  source: Record<string, unknown>,
  projectRoot: string,
  buildCommit = 'dev'
): Record<string, unknown> {
  const config = createSafePlatformConfig(source)
  return {
    ...config,
    name: 'neteco-shop-local',
    define: buildCommitDefinitions(buildCommit),
    main: resolve(projectRoot, 'workers/shop.ts'),
    alias: { '#neteco/nitro-renderer': resolve(projectRoot, '.output-cloudflare/server/index.mjs') },
    assets: {
      directory: resolve(projectRoot, '.output-cloudflare/public'),
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none'
    },
    d1_databases: config.d1_databases.map((binding) => ({
      ...binding,
      migrations_dir: resolve(projectRoot, binding.migrations_dir)
    })),
    vars: createSafeVariables(source, 'local')
  }
}

/** Pure offline projection. No account lookup, import, credentials, upload or apply. */
export function createEnvironmentShopConfig(
  source: Record<string, unknown>,
  projectRoot: string,
  input: unknown,
  buildCommit = 'dev'
): Record<string, unknown> {
  const environment = cloudflareEnvironmentSchema.safeParse(input)
  if (!environment.success) throw new Error('invalid_cloudflare_environment_contract')
  const contract = environment.data
  const local = createLocalShopConfig(source, projectRoot, buildCommit)
  const variables = { ...(local.vars as Record<string, string>) }
  variables.APP_ENV = contract.environment
  variables.NUXT_PUBLIC_APP_ENV = contract.environment
  for (const key of [
    'AUTH_ORIGIN',
    'PUBLIC_SITE_ORIGIN',
    'MEDIA_ADMIN_ORIGIN',
    'PAYMENT_PUBLIC_BASE_URL',
    'NEWSLETTER_PUBLIC_ORIGIN',
    'NUXT_PUBLIC_BASE_URL'
  ]) {
    variables[key] = contract.publicOrigin
  }
  return {
    ...local,
    name: `neteco-iac-${contract.environment}-shop`,
    account_id: contract.accountId,
    vars: variables,
    d1_databases: [
      {
        binding: 'DB',
        database_name: contract.resources.d1.name,
        database_id: contract.resources.d1.id,
        migrations_dir: (local.d1_databases as { migrations_dir: string }[])[0]!.migrations_dir
      }
    ],
    kv_namespaces: [{ binding: 'CACHE', id: contract.resources.kv.id }],
    r2_buckets: [
      { binding: 'MEDIA', bucket_name: contract.resources.r2.name, jurisdiction: contract.resources.r2.jurisdiction }
    ],
    images: { binding: 'IMAGES' },
    send_email: (local.send_email as { name: string; allowed_sender_addresses: string[] }[]).map((binding) => ({
      name: binding.name,
      allowed_sender_addresses: [...binding.allowed_sender_addresses]
    })),
    queues: {
      producers: [{ binding: 'ASYNC_JOBS', queue: contract.resources.queue.name }],
      consumers: [
        {
          queue: contract.resources.queue.name,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
          dead_letter_queue: contract.resources.deadLetterQueue.name
        }
      ]
    },
    workflows: [
      { name: `neteco-iac-${contract.environment}-catalog`, binding: 'CATALOG_WORKFLOW', class_name: 'CanaryWorkflow' }
    ],
    ratelimits: (local.ratelimits as { name: keyof typeof contract.rateLimitNamespaceIds }[]).map((binding) => ({
      ...binding,
      namespace_id: contract.rateLimitNamespaceIds[binding.name]
    }))
  }
}
