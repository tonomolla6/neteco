import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import {
  listSupportKnowledge,
  recordSupportKnowledgeFeedback,
  readSupportKnowledgeFeedback
} from '../../workers/support/knowledge'
import { deterministicTestData } from '../fixtures/deterministic'
import { handleSupportKnowledgeHttp } from '../../workers/support/knowledge-http'

describe('actual workerd D1 published help query', () => {
  it('searches a genuinely published CMS article and preserves review, publication and feedback authority', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'support-knowledge-native-regression',
        script: 'export default {fetch(){return new Response("isolated")}}',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000062' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const native = await runtime.getD1Database('DB'),
        database = native as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < statements.length; index += 50)
          await native.batch(statements.slice(index, index + 50).map((sql) => native.prepare(sql)))
      }
      const data = deterministicTestData('native-support-knowledge'),
        identity = data.uuid(),
        session = data.uuid(),
        now = '2026-10-08T12:00:00Z',
        reviewDueAt = '2099-01-01T00:00:00Z',
        claims = { identityId: identity, sessionId: session, sessionVersion: 1 },
        deps = { database, enabled: true, feedbackEnabled: true, now: () => now },
        title = `Ayuda de navegación ${data.uuid()}`,
        query = { q: title, category: 'envios' as const, page: 1, perPage: 10 }
      await native.batch([
        native
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'native-help@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        native.prepare("INSERT INTO roles VALUES ('native_help','Synthetic','Synthetic')"),
        native.prepare(
          "INSERT OR IGNORE INTO permissions VALUES ('catalog.write','catalog','write','Synthetic'),('catalog.publish','catalog','publish','Synthetic')"
        ),
        native.prepare(
          "INSERT INTO role_permissions VALUES ('native_help','catalog.write'),('native_help','catalog.publish')"
        ),
        native
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native_help','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        native
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity)
      ])
      expect((await listSupportKnowledge(deps, query)).total).toBe(0)
      const created = await executeD1CmsDraftCommand(
        database,
        claims,
        'create_draft',
        {},
        {
          title,
          slug: 'native-help-synthetic',
          blocks: [
            { id: data.uuid(), type: 'paragraph', text: 'Cómo consultar únicamente el estado de un pedido sintético.' },
            {
              id: data.uuid(),
              type: 'list',
              items: ['Referencia ÚNICA de navegación', 'a'.repeat(160), 'Código literal 100%_\\ayuda']
            }
          ],
          seo: {
            title: 'Guía navegación sintética',
            description: 'Artículo sintético sin recomendaciones de productos.',
            noindex: false
          },
          supportKnowledge: { category: 'envios', reviewDueAt },
          changeSummary: 'Creación sintética explícita',
          expectedVersion: 0
        },
        { idempotencyKey: data.uuid(), now }
      )
      await executeCmsPublicationCommand(
        deps,
        claims,
        created.pageId,
        {
          action: 'publish',
          expectedRevision: 0,
          expectedVersion: 1,
          versionId: created.versionId,
          reason: 'Publicación sintética explícita'
        },
        data.uuid()
      )
      await expect(listSupportKnowledge(deps, query)).resolves.toMatchObject({
        total: 1,
        items: [
          {
            id: created.pageId,
            versionId: created.versionId,
            reviewedAt: now,
            reviewDueAt,
            category: 'envios'
          }
        ]
      })
      const response = await handleSupportKnowledgeHttp(
        new Request(`https://native-help.invalid/api/support/knowledge?q=${encodeURIComponent(title)}&category=envios`),
        {
          ...deps,
          origin: 'https://native-help.invalid',
          edgeGate: async () => 'allowed'
        }
      )
      expect(response?.status).toBe(200)
      expect(await response?.json()).toMatchObject({ total: 1, items: [{ id: created.pageId }] })
      expect((await listSupportKnowledge(deps, { ...query, q: 'REFERENCIA UNICA' })).total).toBe(1)
      expect((await listSupportKnowledge(deps, { ...query, q: 'CONSULTAR UNICAMENTE' })).total).toBe(1)
      expect((await listSupportKnowledge(deps, { ...query, q: 'a'.repeat(160) })).total).toBe(1)
      expect((await listSupportKnowledge(deps, { ...query, category: 'pagos' })).total).toBe(0)
      for (const q of ['%', '_', '\\', '100%_\\ayuda'])
        expect((await listSupportKnowledge(deps, { ...query, q })).total).toBe(1)
      for (const q of ['%--', '_--', '\\--', "' OR 1=1 --"])
        expect((await listSupportKnowledge(deps, { ...query, q })).total).toBe(0)
      expect((await listSupportKnowledge({ ...deps, now: () => reviewDueAt }, query)).total).toBe(0)
      const key = data.uuid(),
        body = { pageId: created.pageId, versionId: created.versionId, helpful: true },
        receipt = await recordSupportKnowledgeFeedback(deps, body, key)
      expect(await readSupportKnowledgeFeedback(deps, key)).toEqual(receipt)
      expect(await recordSupportKnowledgeFeedback(deps, body, key)).toEqual(receipt)
      expect(await native.prepare('SELECT count(*) n FROM support_knowledge_feedback').first()).toEqual({ n: 1 })
      await executeCmsPublicationCommand(
        deps,
        claims,
        created.pageId,
        {
          action: 'withdraw',
          expectedRevision: 1,
          expectedVersion: 1,
          reason: 'Retirada sintética explícita'
        },
        data.uuid()
      )
      expect((await listSupportKnowledge(deps, query)).total).toBe(0)
      await expect(recordSupportKnowledgeFeedback(deps, body, data.uuid())).rejects.toMatchObject({
        code: 'article_unavailable'
      })
    } finally {
      await runtime.dispose()
    }
  }, 30000)
})
