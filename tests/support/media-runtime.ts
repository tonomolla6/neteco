import { quarantineMediaUpload, reconcileMediaStorage } from '../../workers/catalog/media'
import { authorizeAdministrativeRequest } from '../../workers/auth/authorize'
import { handleMediaUploadHttp } from '../../workers/media/http'
import { checkAdministrativeEdgeLimit } from '../../workers/auth/edge-limit'
import { hashWorkerPassword, verifyWorkerPassword } from '../../workers/auth/password'
import { completeD1MfaChallenge } from '../../workers/auth/mfa-completion'
import { loginD1 } from '../../workers/auth/login'
import { handleAuthenticationHttp } from '../../workers/auth/http'

// Local audit harness ONLY. Never import into a deployable entrypoint: the SQL
// command is deliberately privileged for crash injection and assertions.
export default {
  async fetch(request, env) {
    const authentication = await handleAuthenticationHttp(request, {
      database: env.DB,
      edgeLimiter: env.AUTH_EDGE_LIMIT,
      configuration: () => ({
        password: env.SESSION_PASSWORD,
        maxAgeSeconds: 3600,
        origin: 'https://media-audit.invalid',
        tokenPepper: env.AUTH_RATE_LIMIT_PEPPER,
        encryptionKey: env.MFA_TEST_KEY
      })
    })
    if (authentication) return authentication
    const media = await handleMediaUploadHttp(request, {
      database: env.DB,
      bucket: env.MEDIA,
      edgeLimiter: env.ADMIN_EDGE_LIMIT,
      configuration: () => ({
        password: env.SESSION_PASSWORD,
        maxAgeSeconds: 3600,
        origin: 'https://media-audit.invalid',
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
    })
    if (media) return media
    const command = await request.json<{
      operation: string
      key?: string
      alt?: string
      sql?: string
      now?: string
      encoded?: string
      password?: string
      challenge?: string
      code?: string
      email?: string
    }>()
    try {
      if (command.operation === 'login' && command.email && command.password)
        return Response.json(
          await loginD1(env.DB, {
            email: command.email,
            password: command.password,
            tokenPepper: env.AUTH_RATE_LIMIT_PEPPER,
            now: command.now
          })
        )
      if (command.operation === 'mfa-complete' && command.challenge && command.code)
        return Response.json(
          await completeD1MfaChallenge(env.DB, {
            challenge: command.challenge,
            code: command.code,
            now: command.now,
            tokenPepper: env.AUTH_RATE_LIMIT_PEPPER,
            encryptionKey: env.MFA_TEST_KEY
          })
        )
      if (command.operation === 'password-check' && command.encoded && command.password)
        return Response.json({
          verified: await verifyWorkerPassword(command.encoded, command.password),
          wrong: await verifyWorkerPassword(command.encoded, `${command.password}x`),
          generated: await hashWorkerPassword(command.password)
        })
      if (command.operation === 'edge-check') {
        const ingress = new Request(request.url, { headers: { 'cf-connecting-ip': '192.0.2.222' } })
        return Response.json({
          outcome: await checkAdministrativeEdgeLimit(ingress, env.TEST_EDGE_LIMIT, env.AUTH_RATE_LIMIT_PEPPER)
        })
      }
      if (command.operation === 'authorize')
        return Response.json(
          await authorizeAdministrativeRequest(
            request,
            env.DB,
            { password: env.SESSION_PASSWORD, maxAgeSeconds: 3600 },
            'catalog.write'
          )
        )
      if (command.operation === 'reconcile')
        return Response.json(await reconcileMediaStorage(env.DB, env.MEDIA, { now: command.now }))
      if (command.operation === 'sql' && command.sql) {
        return Response.json(await env.DB.prepare(command.sql).all())
      }
      if (command.operation === 'objects') {
        const listing = await env.MEDIA.list()
        const objects = await Promise.all(
          listing.objects.map(async (item) => {
            const object = await env.MEDIA.get(item.key)
            return { key: item.key, etag: item.etag, content: await object?.text(), metadata: object?.httpMetadata }
          })
        )
        return Response.json(objects)
      }
      if (command.operation !== 'upload') return new Response('Unknown command', { status: 400 })
      return Response.json(
        await quarantineMediaUpload(env.DB, env.MEDIA, {
          actorId: 'local-audit',
          idempotencyKey: command.key ?? 'local-upload',
          bytes: new TextEncoder().encode('%PDF-1.7 local audit original'),
          declaredType: 'application/pdf',
          filename: '../../manual.pdf',
          alt: command.alt ?? 'Manual de prueba',
          rights: { owner: 'Local fixture', license: 'Test-only fixture', source: 'Local automated test' }
        })
      )
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 500 })
    }
  }
} satisfies ExportedHandler<
  Pick<CloudflareEnv, 'DB' | 'MEDIA' | 'ADMIN_EDGE_LIMIT' | 'AUTH_EDGE_LIMIT' | 'AUTH_RATE_LIMIT_PEPPER'> & {
    SESSION_PASSWORD: string
    MFA_TEST_KEY: string
    TEST_EDGE_LIMIT: RateLimit
  }
>
