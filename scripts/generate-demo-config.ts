import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { experimental_readRawConfig } from 'wrangler'
import { createLocalShopConfig } from './generate-shop-config'
import { DEMO_ORIGIN } from '../shared/demo-access'
import { REDSYS_REDIRECT_URLS } from '../workers/payments/redsys'

export const DEMO_ACCOUNT = '15f0ac470ce8d173cf7633c7bbcba3ec'
export const DEMO_DATABASE = 'd8c99c59-57b3-434d-8f9b-6d6935adfaba'
export const DEMO_BUCKET = 'neteco-preprod-media'
export const DEMO_WORKER = 'neteco-demo'

/** Redsys public test merchant (https://pagosonline.redsys.es/entornosPruebas.html): sis-t only, never production. */
const DEMO_REDSYS_SANDBOX = {
  REDSYS_ENABLED: 'true',
  REDSYS_ENVIRONMENT: 'sandbox',
  REDSYS_MERCHANT_CODE: '999008881',
  REDSYS_TERMINAL: '1',
  REDSYS_BIZUM_ENABLED: 'false'
} as const
const REDSYS_PUBLIC_SANDBOX_SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'
const DEMO_DISABLED_PROVIDERS = [
  'BEPLY_ENABLED',
  'FISCAL_ISSUANCE_ENABLED',
  'REFUND_DISPATCH_ENABLED',
  'CREDIT_DISPATCH_ENABLED',
  'AUTH_EMAIL_ENABLED',
  'NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED',
  'TRANSACTIONAL_EMAIL_ENABLED',
  'INVOICE_EMAIL_ENABLED'
] as const

/** Provisional commercial terms agreed for preproduction (neteco-preview runtime); replace with the real ones. */
const DEMO_COMMERCIAL_TERMS = {
  NUXT_PUBLIC_COMMERCIAL_OWN_DELIVERY_DAYS: "martes y jueves (Ontinyent y la Vall d'Albaida)",
  NUXT_PUBLIC_COMMERCIAL_ORDER_CUTOFF_TIME: '13:00',
  NUXT_PUBLIC_COMMERCIAL_OWN_DELIVERY_COST_CENTS: '600',
  NUXT_PUBLIC_COMMERCIAL_OWN_DELIVERY_FREE_FROM_CENTS: '15000',
  NUXT_PUBLIC_COMMERCIAL_OWN_DELIVERY_MINIMUM_ORDER_CENTS: '3000',
  NUXT_PUBLIC_COMMERCIAL_PARCEL_LEAD_TIME: '24-72 h',
  NUXT_PUBLIC_COMMERCIAL_PARCEL_COST_CENTS: '990',
  NUXT_PUBLIC_COMMERCIAL_DEFERRED_PAYMENT_DAYS: '30',
  NUXT_PUBLIC_COMMERCIAL_DEFERRED_PAYMENT_CONDITIONS: '30 días fecha factura para empresas aprobadas',
  NUXT_PUBLIC_COMMERCIAL_SUPPORT_HOURS: 'Lunes a viernes, 8:00-14:00 y 16:00-19:00',
  NUXT_PUBLIC_COMMERCIAL_CONTACT_EMAIL: 'tienda@neteco.es',
  NUXT_PUBLIC_COMMERCIAL_CONTACT_PHONE: '600 861 334',
  NUXT_PUBLIC_COMMERCIAL_FOUNDED_YEAR: '1998',
  NUXT_PUBLIC_COMMERCIAL_COMPANY_TAX_ID: 'B00000000',
  NUXT_PUBLIC_COMMERCIAL_COMPANY_ADDRESS: 'Polígono Industrial El Pla, 46870 Ontinyent (Valencia)',
  NUXT_PUBLIC_COMMERCIAL_COMPANY_LEGAL_NAME: 'Neteco Suministros Profesionales, S.L. (provisional)',
  NUXT_PUBLIC_COMMERCIAL_COMPANY_REGISTRY: 'Registro Mercantil de Valencia (datos provisionales)',
  NUXT_PUBLIC_COMMERCIAL_DPO_EMAIL: 'tienda@neteco.es',
  NUXT_PUBLIC_COMMERCIAL_DISPUTE_RESOLUTION_ENTITY: 'Junta Arbitral de Consumo de la Comunitat Valenciana',
  FREE_SHIPPING_THRESHOLD_CENTS: '15000',
  NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS: '15000'
} as const

/** Every outbound provider stays off; Redsys may only be on against the public sandbox merchant at sis-t. */
export function demoProviderContractHolds(vars: Record<string, string | undefined> | undefined) {
  if (!vars || DEMO_DISABLED_PROVIDERS.some((name) => vars[name] !== 'false')) return false
  if (vars.REDSYS_ENABLED === 'false') return true
  if (vars.REDSYS_ENABLED !== 'true') return false
  const sandbox = Object.entries(DEMO_REDSYS_SANDBOX).every(([name, value]) => vars[name] === value)
  return sandbox && new URL(REDSYS_REDIRECT_URLS.sandbox).hostname === 'sis-t.redsys.es'
}

/** The documented public test key only; an existing Worker secret is never rotated or overwritten. */
export function prepareDemoRedsysSandboxSecret(names: ReadonlySet<string>) {
  if (names.has('REDSYS_SECRET_KEY')) return {}
  return {
    REDSYS_SECRET_KEY: { name: 'REDSYS_SECRET_KEY', type: 'secret_text' as const, text: REDSYS_PUBLIC_SANDBOX_SECRET }
  }
}

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
      ...DEMO_REDSYS_SANDBOX,
      ...DEMO_COMMERCIAL_TERMS,
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
