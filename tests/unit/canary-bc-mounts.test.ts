import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'
import { ownsSupplierFeedNamespace } from '../../workers/catalog/supplier-feed-comparison-http'
import { ownsEditorialContentNamespace } from '../../workers/catalog/editorial-content-http'
import { ownsSupplierSourcingNamespace } from '../../workers/catalog/supplier-sourcing-http'
import { ownsDraftOrdersNamespace } from '../../workers/b2b/draft-orders-http'

const baseEnv = {
  AUTH_ENABLED: 'false',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  NUXT_SESSION_PASSWORD: 'p'.repeat(64)
} as unknown as CloudflareEnv

describe('Montaje Canary de Encargo BC (CAT-018, CAT-019, CAT-021, CHK-022)', () => {
  it('identifica y posee correctamente los namespaces de las 4 rutas', () => {
    // CAT-018
    expect(ownsSupplierFeedNamespace('/api/admin/supplier-feed/items')).toBe(true)
    expect(ownsSupplierFeedNamespace('/api/admin/supplier-feed/stage')).toBe(true)
    expect(ownsSupplierFeedNamespace('/api/admin/other')).toBe(false)

    // CAT-019
    expect(ownsEditorialContentNamespace('/api/admin/catalog-editorial/article')).toBe(true)
    expect(ownsEditorialContentNamespace('/api/admin/catalog-editorial/upsert')).toBe(true)
    expect(ownsEditorialContentNamespace('/api/admin/other')).toBe(false)

    // CAT-021
    expect(ownsSupplierSourcingNamespace('/api/admin/supplier-sourcing/decision')).toBe(true)
    expect(ownsSupplierSourcingNamespace('/api/admin/supplier-sourcing/offerings')).toBe(true)
    expect(ownsSupplierSourcingNamespace('/api/admin/other')).toBe(false)

    // CHK-022
    expect(ownsDraftOrdersNamespace('/api/admin/draft-orders/list')).toBe(true)
    expect(ownsDraftOrdersNamespace('/api/admin/draft-orders/create')).toBe(true)
    expect(ownsDraftOrdersNamespace('/api/admin/other')).toBe(false)
  })

  it('CAT-018: responde 503 authUnavailable cuando AUTH_ENABLED es false', async () => {
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/supplier-feed/items?importId=00000000-0000-0000-0000-000000000000', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      baseEnv
    )
    expect(res.status).toBe(503)
  })

  it('CAT-018: responde 401 unauthenticated cuando falta sesión', async () => {
    const enabledEnv = { ...baseEnv, AUTH_ENABLED: 'true' } as CloudflareEnv
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/supplier-feed/items?importId=00000000-0000-0000-0000-000000000000', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      enabledEnv
    )
    expect(res.status).toBe(401)
  })

  it('CAT-019: responde 401 unauthenticated cuando falta sesión', async () => {
    const enabledEnv = { ...baseEnv, AUTH_ENABLED: 'true' } as CloudflareEnv
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/catalog-editorial/list', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      enabledEnv
    )
    expect(res.status).toBe(401)
  })

  it('CAT-021: responde 401 unauthenticated cuando falta sesión', async () => {
    const enabledEnv = { ...baseEnv, AUTH_ENABLED: 'true' } as CloudflareEnv
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/supplier-sourcing/offerings?variantId=v1', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      enabledEnv
    )
    expect(res.status).toBe(401)
  })

  it('CHK-022: responde 401 unauthenticated cuando falta sesión', async () => {
    const enabledEnv = { ...baseEnv, AUTH_ENABLED: 'true' } as CloudflareEnv
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/draft-orders/list', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      enabledEnv
    )
    expect(res.status).toBe(401)
  })
})
