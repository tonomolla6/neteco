import { expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { createCompiledShopFixture } from '../support/compiled-shop-fixture'
import { runCompiledBrowserProof } from '../support/compiled-browser-proof'
import { auditNativeResourceHubBrowser } from '../../scripts/lib/audit-native-resource-hub-browser'
import { cmsDocument } from '../unit/d1-cms-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { resourceHubDetailSchema, resourceHubListSchema } from '../../shared/resource-hub'
import { analyticsMeasurementPolicySchema } from '../../shared/analytics-measurement'

// This characterizes current compiled bytes, not a source-bundled renderer,
// browser, remote environment or external publishing/provider acceptance.
it('serves approved resources and metadata in compiled API and initial SSR, excluding expired editorial releases', async () => {
  const data = deterministicTestData('compiled-resource-hub')
  const measurementPolicy = analyticsMeasurementPolicySchema.parse({
    reference: 'synthetic-compiled-resource-measurement',
    version: 'v1',
    purpose: 'first_party_measurement',
    consentVersion: 'v1',
    retentionDays: 1,
    environment: 'local',
    approvedAt: data
      .date()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
  })
  const fixture = await createCompiledShopFixture({
    ANALYTICS_ENABLED: 'true',
    ANALYTICS_POLICY: JSON.stringify(measurementPolicy),
    ANALYTICS_SESSION_PEPPER: Buffer.from(data.token('analytics-pseudonym'), 'hex').toString('base64url'),
    ANALYTICS_PROJECTION_ENABLED: 'false',
    ANALYTICS_RETENTION_ENABLED: 'false',
    EMAIL_ENABLED: 'false'
  })
  try {
    const utc = await fixture.readServerClock()
    const identityId = data.uuid('identity'),
      sessionId = data.uuid('session')
    const claims = { identityId, sessionId, sessionVersion: 1 }
    const db = fixture.database,
      past = utc(-86400000)
    await db.batch([
      db
        .prepare(
          `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES (?,'compiled-cms@example.invalid','synthetic-only',?,'active',?,?)`
        )
        .bind(identityId, past, past, past),
      db.prepare("INSERT INTO roles VALUES ('cms_compiled_editor','CMS editor','Synthetic compiled fixture')"),
      db.prepare(`INSERT OR IGNORE INTO permissions VALUES
        ('catalog.write','catalog','write','CMS authoring'),
        ('catalog.publish','catalog','publish','CMS publication')`),
      db.prepare(`INSERT INTO role_permissions VALUES
        ('cms_compiled_editor','catalog.write'),('cms_compiled_editor','catalog.publish')`),
      db
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'cms_compiled_editor',?)")
        .bind(identityId, past),
      db
        .prepare(
          `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES (?,?,1,1,?,?)`
        )
        .bind(sessionId, identityId, past, utc(3600000))
    ])
    const title = 'Guía compilada de limpieza profesional'
    const description = 'Recurso sintético revisado servido desde el Worker compilado actual.'
    const content = 'Contenido editorial aprobado sintético y visible en el HTML inicial.'
    const author = 'Autora compilada sintética'
    async function publish(slug: string, expired = false, publishedTitle = title) {
      const created = await executeD1CmsDraftCommand(
        db,
        claims,
        'create_draft',
        {},
        {
          ...cmsDocument({
            slug,
            title: expired ? 'Recurso caducado no publicable al lector' : publishedTitle,
            seo: { title: publishedTitle, description, noindex: false },
            blocks: [{ id: data.uuid('block'), type: 'paragraph', text: content }],
            resourceHub: {
              kind: 'article',
              category: { slug: 'limpieza-profesional', label: 'Limpieza profesional' },
              author: { name: author, experience: 'Experiencia editorial sintética exclusivamente para pruebas.' },
              reviewedAt: utc(-86400000),
              reviewDueAt: utc(expired ? -60000 : 86400000),
              pillarSlug: null,
              relatedProducts: [],
              relatedCategories: [],
              relatedResources: []
            }
          }),
          expectedVersion: 0
        },
        { idempotencyKey: data.uuid('draft-command') }
      )
      const receipt = await executeCmsPublicationCommand(
        { database: db, enabled: true },
        claims,
        created.pageId,
        {
          action: 'publish',
          expectedRevision: 0,
          expectedVersion: 1,
          versionId: created.versionId,
          reason: 'Publicación editorial sintética explícita para probar el bundle actual'
        },
        data.uuid('publication-command')
      )
      return { created, receipt }
    }
    const current = await publish('guia-compilada')
    await publish('guia-caducada', true)

    const listResponse = await fixture.dispatch('/api/resources')
    expect(listResponse.status).toBe(200)
    const list = resourceHubListSchema.parse(await listResponse.json())
    expect(list.items.map((item) => item.slug)).toEqual(['guia-compilada'])
    expect(list.items[0]).toMatchObject({
      title,
      description,
      canonicalPath: '/recursos/guia-compilada',
      noindex: false
    })
    const detailResponse = await fixture.dispatch('/api/resources/guia-compilada')
    expect(detailResponse.status).toBe(200)
    const detail = resourceHubDetailSchema.parse(await detailResponse.json())
    expect(detail).toMatchObject({
      source: 'cloudflare',
      preview: false,
      version: 1,
      title,
      description,
      editorial: { author: { name: author } },
      blocks: [{ text: content }]
    })
    expect((await fixture.dispatch('/api/resources/guia-caducada')).status).toBe(404)

    const before = await db.prepare('SELECT count(*) AS n FROM content_publications').first()
    for (const path of ['/recursos', '/recursos/guia-compilada']) {
      const response = await fixture.dispatch(path, {
        headers: {
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none'
        }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const html = await response.text()
      // Strip serialized payload/scripts: text must genuinely exist in SSR DOM.
      const rendered = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      expect(rendered).toContain(title)
      expect(rendered).toContain(description)
      expect(rendered).toContain(author)
      expect(rendered).not.toContain('guia-caducada')
      expect(rendered).not.toContain('Confirmando contenido publicado')
      expect(rendered).not.toContain('compiled-cms@example.invalid')
      expect(rendered).not.toContain(current.created.versionId)
      expect(rendered).not.toContain('/api/content-preview')
      if (path.endsWith('/guia-compilada')) {
        expect(rendered).toContain(content)
        expect(rendered).toMatch(/<title[^>]*>Guía compilada de limpieza profesional/)
        expect(rendered).toMatch(/<meta(?=[^>]*name="description")(?=[^>]*content="Recurso sintético revisado)[^>]*>/)
        expect(rendered).toMatch(
          new RegExp(`<link(?=[^>]*rel="canonical")(?=[^>]*href="${fixture.origin}/recursos/guia-compilada")[^>]*>`)
        )
      }
    }
    // Existing first-party HTTP collector on this SAME compiled Worker/D1.
    // The policy is explicitly synthetic; these are reported page observations,
    // never proof of reading, editorial authority or financial conversion.
    const measurementClock = await fixture.readServerClock()
    const observations = ['/recursos', '/recursos/guia-compilada'].map((path) => ({
      eventId: data.uuid('resource-page-observation'),
      taxonomyVersion: 'v1',
      name: 'page_view',
      occurredAt: measurementClock(),
      properties: { path }
    }))
    const consent = (analytics: boolean) =>
      'neteco-consent-v1=' + encodeURIComponent(JSON.stringify({ version: 'v1', analytics }))
    const sendObservation = (event: (typeof observations)[number], cookie = '') =>
      fixture.dispatch('/api/analytics/events', {
        method: 'POST',
        headers: {
          origin: fixture.origin,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify(event)
      })
    for (const event of observations) {
      for (const cookie of ['', consent(false)]) {
        const denied = await sendObservation(event, cookie)
        expect(denied.status).toBe(403)
        expect(await denied.json()).toEqual({ error: { code: 'consent_required' } })
        expect(denied.headers.get('set-cookie')).toBeNull()
      }
    }
    expect(await db.prepare('SELECT count(*) AS n FROM analytics_client_events').first()).toMatchObject({ n: 0 })
    let anonymousCookie = ''
    for (const event of observations) {
      const accepted = await sendObservation(event, consent(true) + (anonymousCookie ? '; ' + anonymousCookie : ''))
      expect(accepted.status).toBe(202)
      expect(await accepted.json()).toEqual({ accepted: true })
      if (!anonymousCookie) {
        const grant = accepted.headers.get('set-cookie')
        expect(grant).toMatch(/^neteco-analytics-id=[0-9a-f-]{36};/)
        expect(grant).toContain('HttpOnly; Secure; SameSite=Lax')
        anonymousCookie = grant!.split(';')[0]!
      } else expect(accepted.headers.get('set-cookie')).toBeNull()
      const replay = await sendObservation(event, consent(true) + '; ' + anonymousCookie)
      expect(replay.status).toBe(202)
      expect(await replay.json()).toEqual({ accepted: true })
      expect(replay.headers.get('set-cookie')).toBeNull()
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM analytics_client_events WHERE event_id=?')
          .bind(event.eventId)
          .first()
      ).toMatchObject({ n: 1 })
    }
    const measured = await db
      .prepare('SELECT event_id,name,properties_json,session_hash FROM analytics_client_events ORDER BY event_id')
      .all<{ event_id: string; name: string; properties_json: string; session_hash: string }>()
    expect(measured.results).toHaveLength(2)
    for (const row of measured.results) {
      expect(row.name).toBe('page_view')
      expect(row.session_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(row.properties_json)).toEqual(
        observations.find((event) => event.eventId === row.event_id)!.properties
      )
    }
    const measuredBytes = JSON.stringify(measured.results)
    for (const excluded of [
      anonymousCookie.slice(anonymousCookie.indexOf('=') + 1),
      'compiled-cms@example.invalid',
      identityId,
      sessionId,
      author,
      current.created.versionId,
      '192.0.2.123'
    ])
      expect(measuredBytes).not.toContain(excluded)
    await runCompiledBrowserProof(async (browser) => {
      const result = await auditNativeResourceHubBrowser({
        browser,
        origin: fixture.origin,
        dispatch: (request) => fixture.dispatch(request),
        fixture: { slug: 'guia-compilada', expiredSlug: 'guia-caducada', title, description, content, author }
      })
      expect(result).toMatchObject({ scenarios: 3, browserExecuted: true, providerSubmission: false })
    })
    expect(await db.prepare('SELECT count(*) AS n FROM content_publications').first()).toEqual(before)
    // Keep the original one-resource/navigation proof above, then extend this
    // same governed database to the real UI page size, never a reduced test size.
    for (let index = 1; index <= 20; index++)
      await publish('guia-paginada-' + String(index).padStart(2, '0'), false, title + ' ' + index)
    const query = { q: 'limpieza', category: 'limpieza-profesional', kind: 'article' }
    const firstResponse = await fixture.dispatch(
      '/api/resources?' + new URLSearchParams({ ...query, page: '1', perPage: '20' })
    )
    const secondResponse = await fixture.dispatch(
      '/api/resources?' + new URLSearchParams({ ...query, page: '2', perPage: '20' })
    )
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    const first = resourceHubListSchema.parse(await firstResponse.json())
    const second = resourceHubListSchema.parse(await secondResponse.json())
    expect(first).toMatchObject({ page: 1, pages: 2, total: 21 })
    expect(second).toMatchObject({ page: 2, pages: 2, total: 21 })
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(1)
    expect(new Set([...first.items, ...second.items].map((item) => item.slug)).size).toBe(21)
    const window = new Window({
      settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true }
    })
    try {
      for (const [page, expected] of [
        [1, first],
        [2, second]
      ] as const) {
        const response = await fixture.dispatch('/recursos?' + new URLSearchParams({ ...query, page: String(page) }), {
          headers: {
            accept: 'text/html',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'sec-fetch-site': 'none'
          }
        })
        expect(response.status).toBe(200)
        const document = new window.DOMParser().parseFromString(await response.text(), 'text/html')
        for (const script of document.querySelectorAll('script')) script.remove()
        const links = [...document.querySelectorAll('a[href^="/recursos/"]')]
        expect(links.map((link) => link.getAttribute('href')).sort()).toEqual(
          expected.items.map((item) => item.canonicalPath).sort()
        )
        const navigation = document.querySelector('nav[aria-label="Páginas de recursos"]')
        expect(navigation).not.toBeNull()
        const anchors = [...navigation!.querySelectorAll('a')]
        expect(anchors).toHaveLength(1)
        const target = new URL(anchors[0]!.getAttribute('href')!, fixture.origin)
        expect(target.pathname).toBe('/recursos')
        expect([...target.searchParams.entries()].sort()).toEqual(
          [...new URLSearchParams({ ...query, ...(page === 1 ? { page: '2' } : {}) }).entries()].sort()
        )
        expect(document.querySelector('input[data-resource-query]')?.getAttribute('value')).toBe(query.q)
      }
      const unfiltered = await fixture.dispatch('/recursos?page=2', {
        headers: {
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-site': 'none'
        }
      })
      expect(unfiltered.status).toBe(200)
      const document = new window.DOMParser().parseFromString(await unfiltered.text(), 'text/html')
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
        fixture.origin + '/recursos?page=2'
      )
    } finally {
      await window.happyDOM.close()
    }
    expect(fixture.outbound.requests).toBe(0)
  } finally {
    await fixture.dispose()
  }
}, 120000)
