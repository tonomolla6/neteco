import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiTestFixture, ADMIN_SESSION, SESSION_CONFIG, TEST_ORIGIN, TEST_ASSET_ID } from './d1-ai-test-fixture'
import { handleAdminAiAssistantHttp, ownsAdminAiAssistantNamespace } from '../../workers/admin/ai-assistant-http'
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

  it('requires live administrative authority and MFA to check catalog duplicates', async () => {
    const request = (cookie: string) =>
      new Request('https://admin.neteco.test/api/admin/catalog/ai-generate/check-duplicates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: 'Desengrasante industrial' })
      })
    const deps = { database: f.database, sessionCookieConfiguration: SESSION_CONFIG, origin: TEST_ORIGIN }
    expect((await handleCatalogAiGenerationHttp(request(f.unauthorizedCookie), deps))?.status).toBe(403)
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(ADMIN_SESSION)
    expect((await handleCatalogAiGenerationHttp(request(f.adminCookie), deps))?.status).toBe(403)
    f.sqlite
      .prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=? WHERE id=?')
      .run('2026-10-29T00:00:00Z', ADMIN_SESSION)
    expect((await handleCatalogAiGenerationHttp(request(f.adminCookie), deps))?.status).toBe(401)
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

  it('handles decision and retrieval on admin AI assistant HTTP endpoints', async () => {
    // 1. Propose
    const proposeReq = new Request('https://admin.neteco.test/api/admin/ai/assistant/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: f.adminCookie },
      body: JSON.stringify({ category: 'customer_care', prompt: 'Consulta de compatibilidad' })
    })
    const proposeRes = await handleAdminAiAssistantHttp(proposeReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    const propData = (await proposeRes?.json()) as { interaction: { id: string; version: number } }
    const interactionId = propData.interaction.id

    // 2. Read single interaction
    const getReq = new Request(`https://admin.neteco.test/api/admin/ai/assistant/interactions/${interactionId}`, {
      method: 'GET',
      headers: { cookie: f.adminCookie }
    })
    const getRes = await handleAdminAiAssistantHttp(getReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(getRes?.status).toBe(200)

    // 3. Human decision
    const decisionReq = new Request(
      `https://admin.neteco.test/api/admin/ai/assistant/interactions/${interactionId}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: f.adminCookie },
        body: JSON.stringify({ expectedVersion: 1, decision: 'approve', notes: 'Aprobado via HTTP' })
      }
    )
    const decisionRes = await handleAdminAiAssistantHttp(decisionReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(decisionRes?.status).toBe(200)
    const decData = (await decisionRes?.json()) as { interaction: { approvalStatus: string } }
    expect(decData.interaction.approvalStatus).toBe('approved')

    // 4. List interactions
    const listReq = new Request(
      'https://admin.neteco.test/api/admin/ai/assistant/interactions?category=customer_care',
      {
        method: 'GET',
        headers: { cookie: f.adminCookie }
      }
    )
    const listRes = await handleAdminAiAssistantHttp(listReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(listRes?.status).toBe(200)
    const listData = (await listRes?.json()) as { interactions: Array<{ id: string }> }
    expect(listData.interactions.length).toBeGreaterThanOrEqual(1)
  })

  it('handles catalog propose, review and apply full HTTP flow', async () => {
    // 1. Propose
    const proposeReq = new Request('https://admin.neteco.test/api/admin/catalog/ai-generate/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: f.operatorCookie },
      body: JSON.stringify({
        productName: 'Jabón Enzimático',
        targetScope: 'full_editorial',
        prompt: 'Generar ficha de producto enzimático',
        sources: [
          {
            id: 'src-enz-1',
            title: 'Ficha Enzimas',
            type: 'fds',
            verifiedClaims: ['Acción enzimática multiactiva', 'Biodegradable'],
            textSnippet: 'Limpiador biológico de grasas y proteínas.'
          }
        ]
      })
    })
    const proposeRes = await handleCatalogAiGenerationHttp(proposeReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(proposeRes?.status).toBe(200)
    const propData = (await proposeRes?.json()) as { generation: { id: string; version: number } }
    const generationId = propData.generation.id

    // 2. Review
    const reviewReq = new Request(
      `https://admin.neteco.test/api/admin/catalog/ai-generate/generations/${generationId}/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: f.adminCookie },
        body: JSON.stringify({ expectedVersion: 1, decision: 'approve' })
      }
    )
    const reviewRes = await handleCatalogAiGenerationHttp(reviewReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(reviewRes?.status).toBe(200)
    const revData = (await reviewRes?.json()) as { generation: { version: number; approvalStatus: string } }
    expect(revData.generation.approvalStatus).toBe('approved')

    // 3. Apply
    const applyReq = new Request(
      `https://admin.neteco.test/api/admin/catalog/ai-generate/generations/${generationId}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: f.adminCookie },
        body: JSON.stringify({ expectedVersion: revData.generation.version, targetProductId: 'prod-desengrasante-1' })
      }
    )
    const applyRes = await handleCatalogAiGenerationHttp(applyReq, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(applyRes?.status).toBe(200)
    const applyData = (await applyRes?.json()) as { applied: boolean }
    expect(applyData.applied).toBe(true)
  })

  it('rejects unauthenticated requests without session cookie', async () => {
    const req = new Request('https://admin.neteco.test/api/admin/ai/assistant/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'order_ops', prompt: 'test' })
    })
    const res = await handleAdminAiAssistantHttp(req, {
      database: f.database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN
    })
    expect(res?.status).toBe(401)
  })
})
