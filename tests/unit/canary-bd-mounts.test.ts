import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'
import { ownsAlphaBetaPromotionNamespace } from '../../workers/release/alpha-beta-promotion-http'
import { ownsProgressiveRolloutNamespace } from '../../workers/release/progressive-rollout-http'
import { ownsCloudflarePolicyNamespace } from '../../workers/release/cloudflare-policy-http'
import { ownsCampaignPipelineNamespace } from '../../workers/cms/campaign-pipeline-http'

const baseEnv = {
  AUTH_ENABLED: 'true',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  NUXT_SESSION_PASSWORD: 'p'.repeat(64)
} as unknown as CloudflareEnv

describe('Montaje Canary de Encargo BD (CIC-028, CIC-029, CIC-030, CIC-031)', () => {
  it('reconoce la propiedad de los namespaces de los 4 requisitos', () => {
    // CIC-028
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/release/alpha-beta-promotions')).toBe(true)
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/release/alpha-beta-promotions/create')).toBe(true)
    expect(ownsAlphaBetaPromotionNamespace('/api/admin/other')).toBe(false)

    // CIC-029
    expect(ownsProgressiveRolloutNamespace('/api/admin/release/progressive-rollouts')).toBe(true)
    expect(ownsProgressiveRolloutNamespace('/api/release/progressive-rollouts/eval')).toBe(true)
    expect(ownsProgressiveRolloutNamespace('/api/other')).toBe(false)

    // CIC-030
    expect(ownsCloudflarePolicyNamespace('/api/admin/release/cloudflare-policies')).toBe(true)
    expect(ownsCloudflarePolicyNamespace('/api/admin/release/cloudflare-policies/audit')).toBe(true)
    expect(ownsCloudflarePolicyNamespace('/api/admin/other')).toBe(false)

    // CIC-031
    expect(ownsCampaignPipelineNamespace('/api/admin/cms/campaign-pipeline')).toBe(true)
    expect(ownsCampaignPipelineNamespace('/api/campaign-pipeline/preview')).toBe(true)
    expect(ownsCampaignPipelineNamespace('/api/other')).toBe(false)
  })

  it('enruta peticiones administrativas no autenticadas con 401 unauthenticated', async () => {
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/release/alpha-beta-promotions', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      baseEnv
    )
    expect(res.status).toBe(401)
  })

  it('enruta peticiones públicas de preview sin requerir sesión', async () => {
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/campaign-pipeline/preview', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          document: {
            headline: 'Campaña Preview Canary',
            metaDescription: 'Descripción de prueba preview canary',
            sections: [
              {
                id: 'sec-1',
                type: 'hero_banner',
                heading: 'Ofertas Flash',
                imageUrl: 'https://cdn.neteco.es/flash.webp',
                imageAlt: 'Ofertas flash',
                imageWidth: 600,
                imageHeight: 300,
                imageFormat: 'webp',
                imageBytesEstimate: 30000
              }
            ]
          }
        })
      }),
      baseEnv
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.html).toContain('Ofertas Flash')
  })
})
