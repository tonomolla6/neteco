import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_SESSION } from './d1-cms-fixture'
import { handleCmsDraftHttp } from '../../workers/cms/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testUuid } from '../support/deterministic'
const origin = 'https://cms.neteco.invalid',
  password = 'synthetic-cms-session-password-independent'
describe('CMS publication HTTP exact owned routes, CSRF and live capabilities', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>, cookie: string
  beforeEach(async () => {
    f = await cmsPublicationFixture()
    cookie = (await issueD1SessionCookie(f.database, CMS_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => f.sqlite.close())
  const env = () => ({ DB: f.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password })
  function request(suffix: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${origin}/api/admin/content/pages/${f.created.pageId}/${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'idempotency-key': testUuid(),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }
  const publish = () => ({
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: 1,
    versionId: f.created.versionId,
    reason: 'Explicit editorial approval'
  })
  it('default disabled remains501; enabled list is private and publish confirms real release', async () => {
    expect((await handleCmsDraftHttp(request('publish', publish()), env()))?.status).toBe(501)
    const state = await handleCmsDraftHttp(request('publication'), env(), { publication: f.deps })
    expect(state?.status).toBe(200)
    expect(state?.headers.get('cache-control')).toBe('private, no-store')
    expect((await handleCmsDraftHttp(request('publish', publish()), env(), { publication: f.deps }))?.status).toBe(200)
  })
  it.each(['csrf', 'no_cookie', 'wrong_action', 'missing_CAS', 'encoded_route', 'duplicate_query'])(
    'rejects %s without a publication',
    async (kind) => {
      const r =
        kind === 'csrf'
          ? request('publish', publish(), { origin: 'https://outsider.invalid' })
          : kind === 'no_cookie'
            ? request('publish', publish(), { cookie: '' })
            : kind === 'wrong_action'
              ? request('publish', { ...publish(), action: 'preview' })
              : kind === 'missing_CAS'
                ? request('publish', { reason: 'Legacy body' })
                : kind === 'encoded_route'
                  ? request('%70ublish', publish())
                  : request('publication?page=1&page=2')
      const result = await handleCmsDraftHttp(r, env(), { publication: f.deps })
      expect(result?.status).toBe(
        kind === 'csrf' ? 403 : kind === 'no_cookie' ? 401 : ['wrong_action', 'missing_CAS'].includes(kind) ? 422 : 400
      )
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publications').get()?.n).toBe(0)
    }
  )
  it('preview configuration disabled is explicit501 after valid body/auth, no token created', async () => {
    const response = await handleCmsDraftHttp(
      request('preview', { ...publish(), action: 'preview', device: 'mobile' }),
      env(),
      { publication: { ...f.deps, preview: undefined } }
    )
    expect(response?.status).toBe(501)
    expect(await response?.json()).toEqual({ error: { code: 'preview_unavailable' } })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_previews').get()?.n).toBe(0)
  })
  it('revocation at actual batch entry rolls every release, command, audit and head back', async () => {
    const original = f.database.batch
    const deps = {
      ...f.deps,
      database: {
        ...f.database,
        batch: async (statements: D1PreparedStatement[]) => {
          f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CMS_SESSION)
          return original(statements)
        }
      }
    }
    const response = await handleCmsDraftHttp(
      request('publish', publish()),
      { ...env(), DB: deps.database },
      { publication: deps }
    )
    expect(response?.status).toBe(401)
    for (const table of [
      'content_publications',
      'content_publication_states',
      'content_publication_commands',
      'content_publication_audit',
      'content_publication_guards'
    ])
      expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
  })
})
