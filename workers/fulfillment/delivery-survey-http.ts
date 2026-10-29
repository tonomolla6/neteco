import { z } from 'zod'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  DeliverySurveyError,
  readDeliverySurveyByToken,
  submitDeliverySurvey,
  optOutDeliverySurvey,
  readAdminDeliverySurveys,
  CONTACT_REASONS,
  type ContactReason
} from './delivery-survey'

export type DeliverySurveyHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}

function error(code: string, status: number, headers: Record<string, string> = {}) {
  return json({ error: { code } }, status, headers)
}

function statusFromError(code: string): number {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'invalid_input') return 422
  if (code === 'token_used' || code === 'conflict') return 409
  if (code === 'token_expired') return 410
  if (code === 'order_not_delivered') return 409
  return 500
}

export function ownsDeliverySurveyNamespace(pathname: string): boolean {
  return (
    pathname === '/api/fulfillment/delivery-survey' ||
    pathname.startsWith('/api/fulfillment/delivery-survey/') ||
    pathname === '/api/admin/fulfillment/delivery-surveys' ||
    pathname === '/api/admin/delivery-surveys'
  )
}

const submitSchema = z
  .object({
    token: z.string().min(16).max(64),
    score: z.number().int().min(1).max(5),
    arrivedGood: z.boolean(),
    contactReason: z.enum(CONTACT_REASONS).optional().nullable(),
    comment: z.string().max(1000).optional().nullable()
  })
  .strict()

const optOutSchema = z
  .object({
    token: z.string().min(16).max(64).optional(),
    email: z.string().email().optional(),
    reason: z.string().optional()
  })
  .strict()
  .refine((data) => Boolean(data.token || data.email), {
    message: 'Either token or email must be provided'
  })

async function readBody(request: Request, maxBytes = 16384): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new DeliverySurveyError('invalid_input')
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json/i.test(contentType)) {
    throw new DeliverySurveyError('invalid_input')
  }

  try {
    const text = await request.text()
    if (text.length > maxBytes) throw new DeliverySurveyError('invalid_input')
    return JSON.parse(text)
  } catch {
    throw new DeliverySurveyError('invalid_input')
  }
}

export async function handleDeliverySurveyHttp(
  request: Request,
  env: DeliverySurveyHttpEnvironment
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsDeliverySurveyNamespace(url.pathname)) return null

  try {
    // 1. Admin aggregate dashboard: GET /api/admin/fulfillment/delivery-surveys or /api/admin/delivery-surveys
    if (url.pathname === '/api/admin/fulfillment/delivery-surveys' || url.pathname === '/api/admin/delivery-surveys') {
      if (request.method !== 'GET') {
        return error('method_not_allowed', 405, { Allow: 'GET' })
      }

      if (request.headers.get('sec-fetch-site') === 'cross-site') {
        return error('csrf_rejected', 403)
      }

      if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)

      const claims = await verifySessionCookie(request, {
        password: env.NUXT_SESSION_PASSWORD,
        maxAgeSeconds: 3600
      })
      if (!claims) return error('unauthenticated', 401)

      const auth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: false })
      if (!auth.allowed) {
        // Also check if they have support.manage
        const supportAuth = await authorizeD1Session(env.DB, claims, 'support.manage', { requireMfa: false })
        if (!supportAuth.allowed) {
          return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
        }
      }

      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const segment = url.searchParams.get('segment') as 'all' | 'particular' | 'profesional' | undefined
      const contactReason = url.searchParams.get('contactReason') as ContactReason | 'all' | undefined
      const minSampleThreshold = url.searchParams.has('minSampleThreshold')
        ? Number(url.searchParams.get('minSampleThreshold'))
        : 10
      const page = url.searchParams.has('page') ? Number(url.searchParams.get('page')) : 1
      const perPage = url.searchParams.has('perPage') ? Number(url.searchParams.get('perPage')) : 25

      const dashboard = await readAdminDeliverySurveys(env.DB, {
        from,
        to,
        segment,
        contactReason,
        minSampleThreshold: Number.isFinite(minSampleThreshold) && minSampleThreshold > 0 ? minSampleThreshold : 10,
        page: Number.isFinite(page) && page > 0 ? page : 1,
        perPage: Number.isFinite(perPage) && perPage > 0 && perPage <= 100 ? perPage : 25
      })

      const freshAuth = await authorizeD1Session(env.DB, claims, 'administration.manage', { requireMfa: false })
      if (!freshAuth.allowed) {
        const freshSupportAuth = await authorizeD1Session(env.DB, claims, 'support.manage', { requireMfa: false })
        if (!freshSupportAuth.allowed) {
          return error(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
        }
      }

      return json(dashboard, 200)
    }

    // 2. Public submit: POST /api/fulfillment/delivery-survey/submit
    if (url.pathname === '/api/fulfillment/delivery-survey/submit') {
      if (request.method !== 'POST') {
        return error('method_not_allowed', 405, { Allow: 'POST' })
      }

      const body = await readBody(request)
      const parsed = submitSchema.safeParse(body)
      if (!parsed.success) return error('invalid_input', 422)

      const result = await submitDeliverySurvey(env.DB, parsed.data)
      return json(result, 201)
    }

    // 3. Public opt-out: POST /api/fulfillment/delivery-survey/opt-out
    if (url.pathname === '/api/fulfillment/delivery-survey/opt-out') {
      if (request.method !== 'POST') {
        return error('method_not_allowed', 405, { Allow: 'POST' })
      }

      const body = await readBody(request)
      const parsed = optOutSchema.safeParse(body)
      if (!parsed.success) return error('invalid_input', 400)

      const result = await optOutDeliverySurvey(env.DB, parsed.data)
      return json(result, 200)
    }

    // 4. Public survey read: GET /api/fulfillment/delivery-survey
    if (url.pathname === '/api/fulfillment/delivery-survey') {
      if (request.method !== 'GET') {
        return error('method_not_allowed', 405, { Allow: 'GET' })
      }

      const token = url.searchParams.get('token')
      if (!token) return error('invalid_input', 400)

      const details = await readDeliverySurveyByToken(env.DB, token)
      return json(details, 200)
    }

    return error('not_found', 404)
  } catch (err) {
    if (err instanceof DeliverySurveyError) {
      return error(err.code, statusFromError(err.code))
    }
    return error('service_unavailable', 503)
  }
}
