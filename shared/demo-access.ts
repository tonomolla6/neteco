/** Public identifiers only. The demo runs on its own database and session keys. */
export const DEMO_ORIGIN = 'https://neteco.tonomolla.es'
export const DEMO_IDENTITIES = {
  customer: {
    identityId: 'd3100000-0000-4000-8000-000000000001',
    customerId: 'd3200000-0000-4000-8000-000000000001',
    email: 'cliente@demo.invalid'
  },
  admin: {
    identityId: 'd3100000-0000-4000-8000-000000000002',
    customerId: 'd3200000-0000-4000-8000-000000000002',
    email: 'admin@demo.invalid'
  }
} as const
