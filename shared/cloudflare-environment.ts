import { z } from 'zod'

const accountIdentifier = z.string().regex(/^[0-9a-f]{32}$/).refine((value) => value !== '0'.repeat(32))
const databaseIdentifier = z.string().uuid().refine((value) => value !== '00000000-0000-0000-0000-000000000000')
const resourceName = z.string().min(1).max(100)
const namespaceIdentifier = z.string().regex(/^[1-9]\d{0,9}$/)
const publicOrigin = z.string().max(253).refine((value) => {
  try {
    const url = new URL(value)
    return /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && url.origin === value && !url.username && !url.password
  } catch {
    return false
  }
}, 'An explicit HTTPS origin without credentials, path, query or fragment is required')

/** Terraform's single non-secret output, not arbitrary state or a Wrangler override. */
export const cloudflareEnvironmentSchema = z.object({
  environment: z.enum(['preprod', 'production']),
  accountId: accountIdentifier,
  zoneId: accountIdentifier,
  publicOrigin,
  resources: z.object({
    d1: z.object({ name: resourceName, id: databaseIdentifier }).strict(),
    kv: z.object({ name: resourceName, id: accountIdentifier }).strict(),
    r2: z.object({ name: resourceName, jurisdiction: z.literal('eu') }).strict(),
    queue: z.object({ name: resourceName }).strict(),
    deadLetterQueue: z.object({ name: resourceName }).strict()
  }).strict(),
  rateLimitNamespaceIds: z.object({
    AUTH_EDGE_LIMIT: namespaceIdentifier,
    ADMIN_EDGE_LIMIT: namespaceIdentifier,
    CART_EDGE_LIMIT: namespaceIdentifier,
    ANALYTICS_EDGE_LIMIT: namespaceIdentifier
  }).strict()
}).strict().superRefine((value, context) => {
  const prefix = `neteco-iac-${value.environment}`
  for (const [key, suffix] of Object.entries({ d1: 'db', kv: 'cache', r2: 'media', queue: 'jobs', deadLetterQueue: 'jobs-dlq' })) {
    if (value.resources[key as keyof typeof value.resources].name !== `${prefix}-${suffix}`) {
      context.addIssue({ code: 'custom', path: ['resources', key, 'name'], message: 'Dedicated environment resource required; importing demo resources is not supported' })
    }
  }
  const namespaces = Object.values(value.rateLimitNamespaceIds)
  if (new Set(namespaces).size !== namespaces.length) {
    context.addIssue({ code: 'custom', path: ['rateLimitNamespaceIds'], message: 'Rate limit namespaces must be distinct within the account' })
  }
})
export type CloudflareEnvironment = z.infer<typeof cloudflareEnvironmentSchema>
