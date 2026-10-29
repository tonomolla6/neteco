import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { experimental_readRawConfig } from 'wrangler'
import { createLocalShopConfig } from './generate-shop-config'
import { DEMO_ORIGIN } from '../shared/demo-access'

export const DEMO_ACCOUNT = '15f0ac470ce8d173cf7633c7bbcba3ec'
export const DEMO_DATABASE = 'd8c99c59-57b3-434d-8f9b-6d6935adfaba'
export const DEMO_BUCKET = 'neteco-preprod-media'
export const DEMO_WORKER = 'neteco-demo'

/** Separate deployment contract: never changes the production/local generators. */
export function createDemoConfig(source: Record<string, unknown>, projectRoot: string) {
  const local = createLocalShopConfig(source, projectRoot)
  // No cron, queue, workflow or email transport in this public demo.
  const {
    send_email: _email,
    queues: _queues,
    workflows: _workflows,
    triggers: _triggers,
    secrets: _secrets,
    ...platform
  } = local
  return {
    ...platform,
    name: DEMO_WORKER,
    account_id: DEMO_ACCOUNT,
    workers_dev: false,
    preview_urls: false,
    routes: [],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'neteco-preprod',
        database_id: DEMO_DATABASE,
        migrations_dir: resolve(projectRoot, 'db/d1/migrations')
      }
    ],
    kv_namespaces: [{ binding: 'CACHE', id: 'd0e2b234e0654113a69f086eb4b4185b' }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: DEMO_BUCKET, jurisdiction: 'eu' }],
    images: { binding: 'IMAGES' },
    ratelimits: (local.ratelimits as Array<Record<string, unknown>>).map((binding, index) => ({
      ...binding,
      namespace_id: String(9_706_101 + index)
    })),
    vars: {
      ...(local.vars as Record<string, string>),
      APP_ENV: 'preview',
      DEMO_ENABLED: 'true',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: DEMO_ORIGIN,
      PUBLIC_SITE_ORIGIN: DEMO_ORIGIN,
      MEDIA_ADMIN_ORIGIN: DEMO_ORIGIN,
      MEDIA_PUBLIC_ENABLED: 'true',
      MEDIA_ADMIN_ENABLED: 'true',
      CMS_PUBLICATION_ENABLED: 'true',
      CMS_PREVIEW_ENABLED: 'true',
      NEWSLETTER_EDITORIAL_ENABLED: 'true',
      NEWSLETTER_PUBLIC_ORIGIN: DEMO_ORIGIN,
      PAYMENT_PUBLIC_BASE_URL: DEMO_ORIGIN,
      NUXT_PUBLIC_BASE_URL: DEMO_ORIGIN,
      NUXT_PUBLIC_APP_ENV: 'preview',
      NUXT_PUBLIC_DEMO_ENABLED: 'true',
      NUXT_PUBLIC_BANK_TRANSFER_ENABLED: 'false',
      NUXT_PUBLIC_LEGAL_TERMS_URL: `${DEMO_ORIGIN}/legal`,
      NUXT_PUBLIC_PRIVACY_URL: `${DEMO_ORIGIN}/legal`,
      NUXT_PUBLIC_COOKIES_URL: `${DEMO_ORIGIN}/cookies`
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' }) as {
    rawConfig: Record<string, unknown>
  }
  const directory = resolve('.wrangler/demo')
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'wrangler.json'),
    JSON.stringify(createDemoConfig(rawConfig, process.cwd()), null, 2) + '\n',
    { mode: 0o600 }
  )
  await writeFile(
    resolve(directory, 'bootstrap.json'),
    JSON.stringify(
      {
        name: 'neteco-demo-bootstrap',
        account_id: DEMO_ACCOUNT,
        compatibility_date: '2026-08-15',
        compatibility_flags: ['nodejs_compat'],
        workers_dev: false,
        d1_databases: [{ binding: 'DB', database_name: 'neteco-preprod', database_id: DEMO_DATABASE, remote: true }],
        r2_buckets: [{ binding: 'MEDIA', bucket_name: DEMO_BUCKET, jurisdiction: 'eu', remote: true }]
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  await writeFile(resolve('.output-cloudflare/public/.assetsignore'), '**/*.map\n/img/products/**\n/docs/**\n')
  console.log('Isolated demo config generated; no credentials, remote calls or deployment.')
}
