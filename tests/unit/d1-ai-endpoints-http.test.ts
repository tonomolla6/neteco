import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiTestFixture,
  SESSION_CONFIG,
  TEST_ORIGIN,
  TEST_ASSET_ID
} from './d1-ai-test-fixture'
import {
  handleAdminAiAssistantHttp,
  ownsAdminAiAssistantNamespace
} from '../../workers/admin/ai-assistant-http'
import {
  handleCatalogAiGenerationHttp,
  ownsCatalogAiGenerationNamespace
} from '../../workers/catalog/ai-generation-http'
import {
  handleMediaAiEnrichmentHttp,
  ownsMediaAiEnrichmentNamespace
} from '../../workers/catalog/media-ai-enrichment-http'

describe('Admin AI HTTP Handlers (ADM-032, ADM-033, MED-023)', () => {
  let f: Awaited<ReturnType<typeof aiTestFixture>>

  beforeEach(async () => {
    f = await aiTestFixture()
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('correctly matches namespace URLs', () => {
    expect(ownsAdminAiAssistantNamespace('/api/admin/ai/assistant/propose')).toBe(true)
    expect(ownsAdminAiAssistantNamespace('/api/admin/ai/assistant/interactions')).toBe(true)
    expect(ownsAdminAiAssistantNamespace('/api/other')).toBe(false)

    expect(ownsCatalogAiGenerationNamespace('/api/admin/catalog/ai-generate/propose')).toBe(true)
    expect(ownsCatalogAiGenerationNamespace('/api/admin/catalog/ai-generate/check-duplicates')).toBe(true)
    expect(ownsCatalogAiGenerationNamespace('/api/other')).toBe(false)

    expect(ownsMediaAiEnrichmentNamespace('/api/admin/media/ai-enrich/propose')).toBe(true)
    expect(ownsMediaAiEnrichmentNamespace('/api/admin/media/ai-enrich/enrichments')).toBe(true)
    expect(ownsMediaAiEnrichmentNamespace('/api/other')).toBe(false)
  })

  it('POST /api/admin/ai/assistant/propose handles proposals and enforces auth', async () => {
    const unauthReq = new Request('https://admin.neteco.test/api/admin/ai/assistant/propose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: f.unauthorizedCookie
      },
      body: JSON.stringify({
        category: 'catalog_review',
        prompt: 'Revisión rápida de catálogo'
      })
    })

    const unauthRes = await handleAdminAiAssistantHttp(unauthReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })

    expect(unauthRes).toBeDefined()
    expect(unauthRes?.status).toBe(403)

    // Authorized request
    const authReq = new Request('https://admin.neteco.test/api/admin/ai/assistant/propose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: f.adminCookie
      },
      body: JSON.stringify({
        category: 'catalog_review',
        prompt: 'Revisión rápida de catálogo para administradores'
      })
    })

    const authRes = await handleAdminAiAssistantHttp(authReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })

    expect(authRes).toBeDefined()
    expect(authRes?.status).toBe(200)
    const data = (await authRes?.json()) as { interaction: { id: string; proposedReply: string } }
    expect(data.interaction.id).toBeDefined()
    expect(data.interaction.proposedReply).toBeDefined()
  })

  it('POST /api/admin/catalog/ai-generate/check-duplicates checks similarity', async () => {
    const req = new Request('https://admin.neteco.test/api/admin/catalog/ai-generate/check-duplicates', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: f.adminCookie
      },
      body: JSON.stringify({
        text: 'Desengrasante industrial potente para motores',
        title: 'Desengrasante Alcalino'
      })
    })

    const res = await handleCatalogAiGenerationHttp(req, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })

    expect(res).toBeDefined()
    expect(res?.status).toBe(200)
    const result = (await res?.json()) as { duplicateCheck: { maxSimilarityScore: number } }
    expect(result.duplicateCheck).toBeDefined()
  })

  it('POST /api/admin/media/ai-enrich/propose blocks prohibited inventions', async () => {
    const req = new Request('https://admin.neteco.test/api/admin/media/ai-enrich/propose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: f.adminCookie
      },
      body: JSON.stringify({
        assetId: TEST_ASSET_ID,
        enrichmentType: 'full_visual_enrichment',
        options: {
          instruction: 'inventar envase 3D milagroso'
        }
      })
    })

    const res = await handleMediaAiEnrichmentHttp(req, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })

    expect(res).toBeDefined()
    expect(res?.status).toBe(422)
    const body = (await res?.json()) as { error: { code: string } }
    expect(body.error.code).toBe('prohibited_invention_detected')
  })
})
