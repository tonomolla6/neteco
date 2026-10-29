import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { environment } from '../support/customer-operations-fixture'
import { handleCustomerOperationsHttp } from '../../workers/runtime/customer-operations-http'
import worker from '../../workers/canary'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const disabledPaths = [
  '/api/account/product-watches',
  '/api/account/product-watches/commands/10000000-0000-4000-8000-000000000001',
  '/api/account/%70roduct-watches',
  '/api/account/product-watches%2Funknown',
  '/api/account/product-contributions',
  '/api/account/%70roduct-contributions/unknown',
  '/api/admin/product-contributions',
  '/api/admin/product-contributions%2Funknown',
  '/api/products/1/contributions',
  '/api/products/%31/contributions'
]

describe('configured product engagement namespaces', () => {
  it('runs owner submission, private moderation and anonymous projection through the actual Worker and live edge grants', async () => {
    const f = await returnsFixture()
    try {
      f.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0088_product_contributions.sql', import.meta.url), 'utf8')
      )
      f.sqlite
        .prepare("INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic moderation')")
        .run()
      f.sqlite.prepare("INSERT INTO role_permissions VALUES('operator','support.manage')").run()
      f.sqlite
        .prepare(
          "INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,'synthetic-unused',?,?)"
        )
        .run(CLAIMS.identityId, utc(-60000), utc(-60000))
      const productId = (
        f.sqlite.prepare("SELECT legacy_id FROM products WHERE id='p-1'").get() as { legacy_id: number }
      ).legacy_id
      const configuration = {
        password: 'synthetic-root-contributions-session-password-0123456789abcdef',
        maxAgeSeconds: 3600
      }
      const buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
      const adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
      const env = environment({
        AUTH_ENABLED: 'true',
        PRODUCT_CONTRIBUTIONS_ENABLED: 'true',
        DB: f.database,
        NUXT_SESSION_PASSWORD: configuration.password
      })
      const send = (path: string, cookie = '', body?: unknown, selectedEnv = env) =>
        worker.fetch(
          new Request(env.AUTH_ORIGIN + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              cookie,
              'cf-connecting-ip': '192.0.2.88',
              ...(body === undefined
                ? {}
                : {
                    origin: env.AUTH_ORIGIN,
                    'content-type': 'application/json',
                    'idempotency-key': crypto.randomUUID()
                  })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }),
          selectedEnv
        )
      const submitted = await send('/api/account/product-contributions', buyerCookie, {
        kind: 'review',
        productId,
        score: 5,
        title: 'Reseña sintética revisable',
        body: 'Contenido sintético que no se publica sin revisión explícita.',
        privacyAcknowledged: true
      })
      expect(submitted.status).toBe(201)
      const receipt = (await submitted.json()) as { contributionId: string }
      const publicPath = `/api/products/${productId}/contributions`
      expect(await (await send(publicPath)).json()).toMatchObject({ items: [] })
      const moderated = await send(`/api/admin/product-contributions/${receipt.contributionId}/commands`, adminCookie, {
        action: 'publish',
        expectedVersion: 1,
        reason: 'Revisión explícita sintética de publicación',
        reviewReference: 'synthetic-root-review',
        slaDueAt: null
      })
      expect(moderated.status).toBe(201)
      const publicResponse = await send(publicPath, '', undefined, { ...env, AUTH_ENABLED: 'false' })
      expect(publicResponse.status).toBe(200)
      expect(publicResponse.headers.get('cache-control')).toBe('private, no-store')
      expect(await publicResponse.json()).toMatchObject({
        items: [{ origin: 'unverified', title: 'Reseña sintética revisable' }]
      })
      f.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='support.manage'").run()
      const denied = await send(`/api/admin/product-contributions/${receipt.contributionId}/commands`, adminCookie, {
        action: 'withdraw',
        expectedVersion: 2,
        reason: 'Intento sintético con permiso revocado'
      })
      expect(denied.status).toBe(403)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM product_contribution_commands').get()).toEqual({ n: 2 })
      expect(env.ADMIN_EDGE_LIMIT.limit).toHaveBeenCalledTimes(2)
      expect(env.CART_EDGE_LIMIT.limit).toHaveBeenCalledTimes(3)
    } finally {
      f.sqlite.close()
    }
  })

  it.each(disabledPaths)('owns disabled %s before any legacy fallback or body/credential access', async (path) => {
    const env = environment({ AUTH_ENABLED: 'true' })
    const request = new Request(env.AUTH_ORIGIN + path, { method: 'POST', body: 'not-parsed' })
    const response = await handleCustomerOperationsHttp(request, env)
    expect(response, 'disabled new namespaces must not fall through to Nitro').not.toBeNull()
    expect(response!.status).toBe(503)
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
    expect(env.ADMIN_EDGE_LIMIT.limit).not.toHaveBeenCalled()
    expect(env.CART_EDGE_LIMIT.limit).not.toHaveBeenCalled()
  })

  it.each(['/api/account/product-watches', '/api/account/product-contributions', '/api/admin/product-contributions'])(
    'keeps private %s closed when authentication is disabled even if its feature is enabled',
    async (path) => {
      const env = environment({ PRODUCT_WATCH_ENABLED: 'true', PRODUCT_CONTRIBUTIONS_ENABLED: 'true' })
      const request = new Request(env.AUTH_ORIGIN + path, { method: 'POST', body: 'not-parsed' })
      const response = await handleCustomerOperationsHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(503)
      expect(request.bodyUsed).toBe(false)
      expect(env.DB.prepare).not.toHaveBeenCalled()
      expect(env.DB.batch).not.toHaveBeenCalled()
    }
  )

  it.each(['/api/products/1', '/api/account/preferences', '/api/account/product-watches-extra'])(
    'does not capture unrelated %s',
    async (path) => {
      expect(await handleCustomerOperationsHttp(new Request('https://neteco.invalid' + path), environment())).toBeNull()
    }
  )
})
