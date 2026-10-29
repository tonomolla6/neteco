import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newsletterEditorialFixture } from './d1-newsletter-editorial-fixture'
import { auditNativeNewsletterEditorial } from '../../scripts/lib/audit-native-newsletter-editorial'
import { handleNewsletterEditorialHttp } from '../../workers/marketing/newsletter-editorial-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
describe('native newsletter audit helper contracts against actual unit SQLite (not workerd evidence)', () => {
  let w: Awaited<ReturnType<typeof newsletterEditorialFixture>>
  beforeEach(async () => {
    w = await newsletterEditorialFixture()
    w.deps.now = undefined
  })
  afterEach(() => w.sqlite.close())
  it.each([false, true])('runs real consent/HTTP/cap/withdraw assertions with feedback=%s', async (feedback) => {
    const adminCookie = (await issueD1SessionCookie(w.database, w.claims, w.deps.session!))!.split(';')[0]!,
      identity = crypto.randomUUID(),
      session = crypto.randomUUID(),
      now = new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      future = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    w.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'simple-newsletter@example.invalid','synthetic-only',?,'active',?,?)"
      )
      .run(identity, now, now, now)
    w.sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(session, identity, now, future)
    const unprivilegedCookie = (await issueD1SessionCookie(
        w.database,
        { identityId: identity, sessionId: session, sessionVersion: 1 },
        w.deps.session!
      ))!.split(';')[0]!,
      names: string[] = []
    const result = await auditNativeNewsletterEditorial({
      dispatch: async (request) =>
        (await handleNewsletterEditorialHttp(request, w.deps)) ?? new Response('not_owned', { status: 404 }),
      database: w.database,
      origin: w.deps.publicOrigin,
      adminCookie,
      unprivilegedCookie,
      newsletterSecrets: w.secrets,
      ...(feedback ? { feedbackSecret: w.deps.feedback!.secret } : {}),
      scenario: (name) => names.push(name)
    })
    expect(result.scenarios).toBe(feedback ? 8 : 7)
    expect(names).toHaveLength(result.scenarios)
    expect(w.sent).toHaveLength(1)
  })
})
