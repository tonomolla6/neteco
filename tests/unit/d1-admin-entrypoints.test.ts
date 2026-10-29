import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS, CATEGORY_SESSION } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

describe('native administrative entrypoints at the actual Worker dispatcher', () => {
  it('does not let unrelated CMS misconfiguration break the private support namespace', async () => {
    const response = await worker.fetch(new Request('https://neteco.invalid/api/support/tickets'), {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false',
      SUPPORT_ENABLED: 'false',
      CMS_PUBLICATION_ENABLED: 'invalid'
    } as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
  it('includes the synonym command and preview schema in the shared clean-database fixture', async () => {
    const database = await openMigratedDatabase()
    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'search_synonym_%' ORDER BY name")
        .all()
      expect(tables.map((row) => row.name)).toEqual(['search_synonym_commands', 'search_synonym_previews'])
    } finally {
      database.close()
    }
  })

  it('includes anonymous knowledge feedback in every clean database', async () => {
    const database = await openMigratedDatabase()
    try {
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name='support_knowledge_feedback'").get()).toEqual({
        name: 'support_knowledge_feedback'
      })
    } finally {
      database.close()
    }
  })

  it('serves enabled published knowledge publicly even when private support is disabled, with feedback off without its limiter', async () => {
    const sqlite = await openMigratedDatabase()
    try {
      const origin = 'https://neteco.invalid',
        env = {
          APP_ENV: 'local',
          AUTH_ENABLED: 'false',
          AUTH_ORIGIN: origin,
          SUPPORT_ENABLED: 'false',
          CMS_PUBLICATION_ENABLED: 'true',
          DB: d1OverSqlite(sqlite)
        } as unknown as CloudflareEnv
      const response = await worker.fetch(new Request(origin + '/api/support/knowledge'), env)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(await response.json()).toEqual({
        source: 'cloudflare',
        items: [],
        total: 0,
        page: 1,
        perPage: 10,
        categories: [],
        feedbackEnabled: false
      })
      const feedback = await worker.fetch(
        new Request(origin + '/api/support/knowledge/feedback', {
          method: 'POST',
          headers: { Origin: origin }
        }),
        env
      )
      expect(feedback.status).toBe(503)
      expect(await feedback.json()).toEqual({ error: { code: 'feedback_unavailable' } })
    } finally {
      sqlite.close()
    }
  })

  it.each([
    ['GET', '/api/support/knowledge'],
    ['POST', '/api/support/knowledge/feedback'],
    ['GET', '/api/support/knowledge/feedback/10000000-0000-4000-8000-000000000001']
  ])('owns disabled knowledge route %s %s without a legacy fallback', async (method, path) => {
    const prepare = vi.fn(() => {
      throw new Error('Disabled knowledge must not read the database')
    })
    const response = await worker.fetch(new Request(`https://neteco.invalid${path}`, { method }), {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false',
      CMS_PUBLICATION_ENABLED: 'false',
      DB: { prepare }
    } as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'knowledge_unavailable' } })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/admin/activity'],
    ['POST', '/api/admin/activity'],
    ['GET', '/api/admin/global-search?q=sku'],
    ['POST', '/api/admin/global-search?q=sku'],
    ['GET', '/api/admin/capabilities'],
    ['GET', '/api/admin/search-synonyms'],
    ['POST', '/api/admin/search-synonyms/preview'],
    ['GET', '/api/admin/search-synonyms/commands/recovery-key'],
    ['PUT', '/api/admin/search-synonyms/10000000-0000-4000-8000-000000000001']
  ])('owns %s %s without falling through to an absent legacy route', async (method, path) => {
    const prepare = vi.fn(() => {
      throw new Error('Disabled administration must not read private data')
    })
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false',
      DB: { prepare }
    } as unknown as CloudflareEnv
    const response = await worker.fetch(new Request(`https://neteco.invalid${path}`, { method }), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not claim unrelated missing administrative endpoints', async () => {
    const response = await worker.fetch(new Request('https://neteco.invalid/api/admin/absent-native-feature'), {
      APP_ENV: 'local',
      AUTH_ENABLED: 'false'
    } as CloudflareEnv)
    expect(response.status).toBe(404)
  })

  it('dispatches live staff capabilities and a recoverable synonym command, then rejects the revoked session', async () => {
    const { sqlite, database } = await categoryCommandFixture()
    try {
      const origin = 'https://neteco.invalid',
        password = 'synthetic-only-dispatch-cookie-secret-over-32',
        cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
          ';'
        )[0]!,
        env = {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          AUTH_ORIGIN: origin,
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-dispatch-edge-pepper-over-32',
          NUXT_SESSION_PASSWORD: password,
          ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
          DB: database
        } as unknown as CloudflareEnv
      const dispatch = (path: string, method = 'GET', payload?: unknown) =>
        worker.fetch(
          new Request(origin + path, {
            method,
            headers: {
              Cookie: cookie,
              Origin: origin,
              'CF-Connecting-IP': '192.0.2.181',
              'Content-Type': 'application/json',
              'Idempotency-Key': 'entrypoint-command'
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
          }),
          env
        )
      const capabilities = await dispatch('/api/admin/capabilities')
      expect(capabilities.status).toBe(200)
      expect(await capabilities.json()).toMatchObject({
        source: 'cloudflare',
        ...CATEGORY_CLAIMS,
        state: 'ready',
        permissions: ['administration.manage', 'catalog.write']
      })
      const activity = await dispatch('/api/admin/activity?limit=5')
      expect(activity.status).toBe(200)
      expect(await activity.json()).toEqual({ source: 'cloudflare', items: [], nextCursor: null })
      const globalSearch = await dispatch('/api/admin/global-search?q=missing-synthetic-sku')
      expect(globalSearch.status).toBe(200)
      expect(globalSearch.headers.get('cache-control')).toBe('private, no-store')
      expect(await globalSearch.json()).toEqual({
        source: 'cloudflare',
        query: 'missing-synthetic-sku',
        items: []
      })
      const preview = await dispatch('/api/admin/search-synonyms/preview', 'POST', {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm: 'lejía',
          replacements: ['hipoclorito'],
          active: true,
          reason: 'Terminología sintética de prueba',
          action: 'save'
        },
        query: 'lejía'
      })
      expect(preview.status).toBe(200)
      const { previewId, previewHash } = (await preview.json()) as { previewId: string; previewHash: string }
      const committed = await dispatch('/api/admin/search-synonyms', 'POST', { previewId, previewHash })
      expect(committed.status).toBe(201)
      const receipt = await committed.text()
      const recovered = await dispatch('/api/admin/search-synonyms/commands/entrypoint-command')
      expect(recovered.status).toBe(200)
      expect(await recovered.text()).toBe(receipt)
      const listed = await dispatch('/api/admin/search-synonyms')
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject({ source: 'cloudflare', total: 1 })
      sqlite
        .prepare("UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
        .run(CATEGORY_SESSION)
      expect((await dispatch('/api/admin/capabilities')).status).toBe(401)
      expect((await dispatch('/api/admin/activity?limit=5')).status).toBe(401)
      expect((await dispatch('/api/admin/global-search?q=missing-synthetic-sku')).status).toBe(401)
      expect((await dispatch('/api/admin/search-synonyms/commands/entrypoint-command')).status).toBe(401)
    } finally {
      sqlite.close()
    }
  })
})
