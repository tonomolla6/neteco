/** Reviewed, locally emulatable Neteco bindings. New resources or Wrangler
 * options must be reviewed here; never clone an unrestricted source config. */
const LOCAL_PLATFORM = {
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'neteco-canary-local',
      database_id: '00000000-0000-0000-0000-000000000000',
      migrations_dir: 'db/d1/migrations',
      remote: false
    }
  ],
  kv_namespaces: [{ binding: 'CACHE', id: '00000000000000000000000000000000', remote: false }],
  r2_buckets: [{ binding: 'MEDIA', bucket_name: 'neteco-canary-local', remote: false }],
  images: { binding: 'IMAGES', remote: false },
  send_email: [
    { name: 'EMAIL', allowed_sender_addresses: ['orders@neteco.es'], remote: false },
    { name: 'NEWSLETTER_EMAIL', allowed_sender_addresses: ['newsletter@neteco.es'], remote: false }
  ],
  queues: {
    producers: [{ binding: 'ASYNC_JOBS', queue: 'neteco-canary-local', remote: false }],
    consumers: [
      {
        queue: 'neteco-canary-local',
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: 3,
        dead_letter_queue: 'neteco-canary-local-dlq'
      }
    ]
  },
  workflows: [
    { name: 'neteco-canary-workflow', binding: 'CATALOG_WORKFLOW', class_name: 'CanaryWorkflow' }
  ],
  durable_objects: {
    bindings: [
      { name: 'COORDINATOR', class_name: 'CanaryCoordinator' },
      { name: 'INVENTORY', class_name: 'InventoryCoordinator' },
      { name: 'CARTS', class_name: 'CartCoordinator' }
    ]
  },
  migrations: [
    { tag: 'v1', new_sqlite_classes: ['CanaryCoordinator'] },
    { tag: 'v2', new_sqlite_classes: ['InventoryCoordinator'] },
    { tag: 'v3', new_sqlite_classes: ['CartCoordinator'] }
  ],
  ratelimits: [
    { name: 'AUTH_EDGE_LIMIT', namespace_id: '900003', simple: { limit: 30, period: 60 } },
    { name: 'ADMIN_EDGE_LIMIT', namespace_id: '900001', simple: { limit: 300, period: 60 } },
    { name: 'CART_EDGE_LIMIT', namespace_id: '900004', simple: { limit: 30, period: 60 } },
    { name: 'ANALYTICS_EDGE_LIMIT', namespace_id: '900005', simple: { limit: 60, period: 60 } }
  ]
}

const SECRET_NAMES = [
  'REDSYS_SECRET_KEY',
  'NUXT_SESSION_PASSWORD',
  'AUTH_RATE_LIMIT_PEPPER',
  'AUTH_TOKEN_PEPPER',
  'AUTH_ENCRYPTION_KEY',
  'NEWSLETTER_HMAC_KEY',
  'MEDIA_SCAN_SECRET'
]
const CREDENTIAL_NAMES = new Set([
  ...SECRET_NAMES,
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'BEPLY_API_TOKEN',
  'CMS_PREVIEW_SECRET',
  'SUPPORT_SCAN_SECRET',
  'SUPPORT_TURNSTILE_SECRET',
  'NEWSLETTER_FEEDBACK_SECRET',
  'ANALYTICS_SESSION_PEPPER',
  'DATABASE_URL',
  'REDIS_URL'
])

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  // Parsed Wrangler records contain data, not accessors. Inspect descriptors
  // without invoking getters; a value must not change after its validation.
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor !== undefined && 'value' in descriptor
  })
}

/** Strict nested allowlist. Only explicit remote:false is optional in source;
 * script_name, environment, preview IDs, credentials and extra bindings fail. */
function assertContract(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      throw new Error('unsafe_cloudflare_binding_contract')
    expected.forEach((value, index) => assertContract(actual[index], value))
  } else if (record(expected)) {
    if (!record(actual) || Object.keys(actual).some((key) => !Object.hasOwn(expected, key)))
      throw new Error('unsafe_cloudflare_binding_contract')
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) {
        if (key === 'remote') continue
        throw new Error('unsafe_cloudflare_binding_contract')
      }
      assertContract(actual[key], value)
    }
  } else if (actual !== expected) throw new Error('unsafe_cloudflare_binding_contract')
}

/** The output allowlist deliberately excludes source env, aliases, routes,
 * account, services, unsafe bindings, custom builds and process instructions. */
export function createSafePlatformConfig(source: Record<string, unknown>) {
  if (!record(source)) throw new Error('invalid_cloudflare_source_config')
  for (const [key, value] of Object.entries(LOCAL_PLATFORM)) {
    if (!Object.hasOwn(source, key)) throw new Error('unsafe_cloudflare_binding_contract')
    assertContract(source[key], value)
  }
  const compatibilityDate = source.compatibility_date
  if (typeof compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate))
    throw new Error('invalid_cloudflare_compatibility_date')
  assertContract(source.compatibility_flags, ['nodejs_compat'])
  assertContract(source.observability, { enabled: true, head_sampling_rate: 1 })
  assertContract(source.upload_source_maps, true)
  assertContract(source.triggers, { crons: ['* * * * *'] })

  return {
    ...structuredClone(LOCAL_PLATFORM),
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true, head_sampling_rate: 1 },
    upload_source_maps: true,
    triggers: { crons: ['* * * * *'] },
    secrets: { required: [...SECRET_NAMES] },
    workers_dev: false,
    preview_urls: false,
    routes: []
  }
}

/** No unknown variable is copied, even if it looks public or is not declared
 * in secrets.required. Known/declared credentials fail without echoing values. */
export function createSafeVariables(source: Record<string, unknown>, environment: 'local' | 'preprod') {
  if (!record(source)) throw new Error('invalid_cloudflare_source_config')
  const ownVariables = Object.hasOwn(source, 'vars') ? source.vars : undefined
  if (ownVariables !== undefined && !record(ownVariables)) throw new Error('invalid_cloudflare_variables')
  const variables = (ownVariables ?? {}) as Record<string, unknown>
  const declaredSecrets = Object.hasOwn(source, 'secrets') ? source.secrets : undefined
  if (
    declaredSecrets !== undefined &&
    (!record(declaredSecrets) ||
      Object.keys(declaredSecrets).some((key) => key !== 'required') ||
      !Object.hasOwn(declaredSecrets, 'required') ||
      !Array.isArray(declaredSecrets.required) ||
      declaredSecrets.required.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)))
  )
    throw new Error('invalid_cloudflare_secret_metadata')
  const required = (declaredSecrets as { required?: string[] } | undefined)?.required ?? []
  for (const name of new Set([...CREDENTIAL_NAMES, ...required])) {
    if (Object.hasOwn(variables, name) && variables[name] !== '')
      throw new Error('cloudflare_configuration_contains_credentials')
  }
  const shippingThreshold = Object.hasOwn(variables, 'FREE_SHIPPING_THRESHOLD_CENTS')
    ? variables.FREE_SHIPPING_THRESHOLD_CENTS
    : '0'
  if (
    typeof shippingThreshold !== 'string' ||
    !/^(?:0|[1-9]\d{0,9})$/.test(shippingThreshold) ||
    !Number.isSafeInteger(Number(shippingThreshold))
  )
    throw new Error('invalid_cloudflare_shipping_threshold')
  const origin = environment === 'local' ? 'https://neteco.invalid' : 'https://preprod.neteco.es'
  return {
    APP_ENV: environment,
    FREE_SHIPPING_THRESHOLD_CENTS: shippingThreshold,
    AUTH_ENABLED: 'false',
    INVENTORY_ALERTS_ENABLED: 'false',
    CART_RECOVERY_ENABLED: 'false',
    CART_RECOVERY_DELIVERY_ENABLED: 'false',
    CART_RECOVERY_POLICY: 'null',
    CART_RECOVERY_ALLOWED_RECIPIENTS: '[]',
    PRODUCT_WATCH_ENABLED: 'false',
    PRODUCT_WATCH_DELIVERY_ENABLED: 'false',
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: '[]',
    PRODUCT_CONTRIBUTIONS_ENABLED: 'false',
    SALES_QUOTES_ENABLED: 'false',
    CUSTOMER_360_ENABLED: 'false',
    ANALYTICS_ENABLED: 'false',
    ANALYTICS_PROJECTION_ENABLED: 'false',
    ANALYTICS_RETENTION_ENABLED: 'false',
    ANALYTICS_POLICY: 'null',
    AUTH_EMAIL_ENABLED: 'false',
    AUTH_EMAIL_FROM: 'orders@neteco.es',
    AUTH_ORIGIN: origin,
    PUBLIC_SITE_ORIGIN: origin,
    MEDIA_ADMIN_ENABLED: 'false',
    MEDIA_PUBLIC_ENABLED: 'false',
    MEDIA_ADMIN_ORIGIN: origin,
    CMS_PUBLICATION_ENABLED: 'false',
    CMS_PREVIEW_ENABLED: 'false',
    FISCAL_ISSUANCE_ENABLED: 'false',
    FISCAL_LOCAL_VALIDATION_ENABLED: 'false',
    FISCAL_POLICY_IDS: '[]',
    REFUNDS_ENABLED: 'false',
    REFUND_DISPATCH_ENABLED: 'false',
    REFUND_LOCAL_VALIDATION_ENABLED: 'false',
    REFUND_POLICY_IDS: '[]',
    CREDIT_DISPATCH_ENABLED: 'false',
    CREDIT_LOCAL_VALIDATION_ENABLED: 'false',
    CREDIT_POLICY_IDS: '[]',
    SUPPORT_ENABLED: 'false',
    SUPPORT_POLICY: 'null',
    SUPPORT_ATTACHMENTS_ENABLED: 'false',
    SUPPORT_TURNSTILE_ENABLED: 'false',
    SUPPORT_TURNSTILE_SITE_KEY: '',
    BEPLY_ENABLED: 'false',
    BEPLY_ENVIRONMENT: 'sandbox',
    BEPLY_BASE_URL: '',
    BEPLY_INVOICE_SERIES: '',
    BEPLY_CORRECTIVE_SERIES: '',
    BEPLY_COMPANY_ID: '',
    BEPLY_TAX_CODE_0: '',
    BEPLY_TAX_CODE_10: '',
    BEPLY_TAX_CODE_21: '',
    BEPLY_PAYMENT_CODE_REDSYS: '',
    BEPLY_PAYMENT_CODE_BANK_TRANSFER: '',
    REDSYS_ENABLED: 'false',
    REDSYS_ENVIRONMENT: 'sandbox',
    REDSYS_MERCHANT_CODE: '',
    REDSYS_TERMINAL: '',
    REDSYS_BIZUM_ENABLED: 'false',
    PAYMENT_PUBLIC_BASE_URL: origin,
    NEWSLETTER_ENABLED: 'false',
    NEWSLETTER_EDITORIAL_ENABLED: 'false',
    NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false',
    NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'false',
    NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '[]',
    NEWSLETTER_FEEDBACK_ENABLED: 'false',
    NEWSLETTER_PUBLIC_ORIGIN: origin,
    NEWSLETTER_EMAIL_FROM: 'newsletter@neteco.es',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_FROM: 'orders@neteco.es',
    INVOICE_EMAIL_ENABLED: 'false',
    INVOICE_VALIDATION_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_RENDERER_KEYS: '[]',
    TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED: 'false',
    NUXT_PUBLIC_APP_ENV: environment,
    NUXT_PUBLIC_BASE_URL: origin,
    NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS: shippingThreshold
  }
}
