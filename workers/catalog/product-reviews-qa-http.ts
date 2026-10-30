import { readProductReviewSeoSummary } from './product-review-seo'
import {
  submitProductReview,
  submitProductQuestion,
  moderateProductReview,
  moderateProductQuestion,
  merchantReplyProductReview,
  officialAnswerProductQuestion,
  revokeReviewQaConsent,
  listPublicProductReviews,
  listPublicProductQuestions,
  listAdminProductReviews,
  listAdminProductQuestions,
  ProductReviewsQaError
} from './product-reviews-qa'

export interface SessionClaims {
  identityId: string
  customerId: string | null
  sessionId: string
  sessionVersion: number
}

export interface ProductReviewsQaContext {
  database: D1Database
  now?: () => string
  sessionClaimsResolver: (request: Request) => Promise<SessionClaims | null>
}

interface ReviewRequestBody {
  orderId?: string
  rating?: number
  title?: string
  content?: string
  displayName?: string
  consentAccepted?: boolean
  commandId?: string
}

interface QuestionRequestBody {
  title?: string
  content?: string
  displayName?: string
  consentAccepted?: boolean
  commandId?: string
}

interface ConsentRevocationBody {
  entityType?: 'review' | 'question'
  anonymizeOnly?: boolean
  expectedVersion?: number
  commandId?: string
}

interface AdminReviewCommandBody {
  action?: 'approve' | 'reject' | 'quarantine' | 'reply'
  merchantResponse?: string
  reason?: string
  expectedVersion?: number
  commandId?: string
}

interface AdminQuestionCommandBody {
  action?: 'approve' | 'reject'
  officialAnswer?: string
  reason?: string
  expectedVersion?: number
  commandId?: string
}

export function ownsProductReviewsQaNamespace(pathname: string): boolean {
  return (
    /^\/api\/products\/[^/]+\/reviews(?:\/.*)?$/.test(pathname) ||
    /^\/api\/products\/[^/]+\/questions(?:\/.*)?$/.test(pathname) ||
    /^\/api\/reviews\/[^/]+\/consent-revocation$/.test(pathname) ||
    /^\/api\/admin\/reviews(?:\/.*)?$/.test(pathname) ||
    /^\/api\/admin\/questions(?:\/.*)?$/.test(pathname)
  )
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  })
}

function errorResponse(code: string, status = 400): Response {
  return jsonResponse({ error: { code } }, status)
}

async function verifyAdminAuthority(db: D1Database, identityId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM identity_roles ir
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE ir.identity_id = ? AND rp.permission_code IN ('support.manage', 'catalog.write', 'catalog.manage', 'administration.manage')`
    )
    .bind(identityId)
    .first()
  return Boolean(row)
}

export async function handleProductReviewsQaHttp(
  request: Request,
  context: ProductReviewsQaContext
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname
  if (!ownsProductReviewsQaNamespace(pathname)) return null

  const currentTime = context.now ? context.now() : new Date().toISOString()
  const method = request.method

  try {
    // 0. GET /api/products/:productId/reviews/summary (public, SEO-026 AggregateRating source)
    const summaryMatch = /^\/api\/products\/([^/]+)\/reviews\/summary$/.exec(pathname)
    if (summaryMatch) {
      if (method !== 'GET') return errorResponse('method_not_allowed', 405)
      return jsonResponse(
        await readProductReviewSeoSummary(context.database, decodeURIComponent(summaryMatch[1]!)),
        200
      )
    }

    // 1. GET /api/products/:productId/reviews (public)
    const publicReviewsMatch = /^\/api\/products\/([^/]+)\/reviews$/.exec(pathname)
    if (publicReviewsMatch && method === 'GET') {
      const productId = publicReviewsMatch[1]!
      const data = await listPublicProductReviews(context.database, productId)
      return jsonResponse(data, 200)
    }

    // 2. GET /api/products/:productId/questions (public)
    const publicQuestionsMatch = /^\/api\/products\/([^/]+)\/questions$/.exec(pathname)
    if (publicQuestionsMatch && method === 'GET') {
      const productId = publicQuestionsMatch[1]!
      const data = await listPublicProductQuestions(context.database, productId)
      return jsonResponse(data, 200)
    }

    // 3. POST /api/products/:productId/reviews (authenticated customer)
    if (publicReviewsMatch && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims || !claims.customerId) return errorResponse('unauthenticated', 401)

      const body = (await request.json().catch(() => null)) as ReviewRequestBody | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const productId = publicReviewsMatch[1]!
      const result = await submitProductReview(context.database, {
        productId,
        customerId: claims.customerId,
        actorId: claims.identityId,
        orderId: body.orderId,
        rating: body.rating ?? 5,
        title: body.title ?? '',
        content: body.content ?? '',
        displayName: body.displayName ?? 'Cliente verificado',
        consentAccepted: body.consentAccepted ?? false,
        commandId: body.commandId ?? crypto.randomUUID(),
        now: currentTime
      })

      return jsonResponse({ review: result }, 201)
    }

    // 4. POST /api/products/:productId/questions (authenticated customer)
    if (publicQuestionsMatch && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims || !claims.customerId) return errorResponse('unauthenticated', 401)

      const body = (await request.json().catch(() => null)) as QuestionRequestBody | null
      if (!body || typeof body !== 'object') return errorResponse('invalid_input', 400)

      const productId = publicQuestionsMatch[1]!
      const result = await submitProductQuestion(context.database, {
        productId,
        customerId: claims.customerId,
        actorId: claims.identityId,
        title: body.title ?? '',
        content: body.content ?? '',
        displayName: body.displayName ?? 'Cliente',
        consentAccepted: body.consentAccepted ?? false,
        commandId: body.commandId ?? crypto.randomUUID(),
        now: currentTime
      })

      return jsonResponse({ question: result }, 201)
    }

    // 5. POST /api/reviews/:reviewId/consent-revocation (authenticated customer)
    const consentMatch = /^\/api\/reviews\/([^/]+)\/consent-revocation$/.exec(pathname)
    if (consentMatch && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims || !claims.customerId) return errorResponse('unauthenticated', 401)

      const body = ((await request.json().catch(() => ({}))) ?? {}) as ConsentRevocationBody
      const result = await revokeReviewQaConsent(context.database, {
        entityId: consentMatch[1]!,
        entityType: body.entityType ?? 'review',
        customerId: claims.customerId,
        actorId: claims.identityId,
        anonymizeOnly: body.anonymizeOnly ?? true,
        expectedVersion: body.expectedVersion ?? 1,
        commandId: body.commandId ?? crypto.randomUUID(),
        now: currentTime
      })

      return jsonResponse(result, 200)
    }

    // 6. GET /api/admin/reviews (admin)
    if (pathname === '/api/admin/reviews' && method === 'GET') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const data = await listAdminProductReviews(context.database)
      return jsonResponse(data, 200)
    }

    // 7. GET /api/admin/questions (admin)
    if (pathname === '/api/admin/questions' && method === 'GET') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const data = await listAdminProductQuestions(context.database)
      return jsonResponse(data, 200)
    }

    // 8. POST /api/admin/reviews/:reviewId/commands (admin: moderate or merchant reply)
    const adminRevCmdMatch = /^\/api\/admin\/reviews\/([^/]+)\/commands$/.exec(pathname)
    if (adminRevCmdMatch && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const body = (await request.json().catch(() => null)) as AdminReviewCommandBody | null
      if (!body) return errorResponse('invalid_input', 400)

      const reviewId = adminRevCmdMatch[1]!
      if (body.action === 'reply' || body.merchantResponse) {
        const result = await merchantReplyProductReview(context.database, {
          reviewId,
          actorId: claims.identityId,
          merchantResponse: body.merchantResponse ?? '',
          expectedVersion: body.expectedVersion ?? 0,
          commandId: body.commandId ?? crypto.randomUUID(),
          now: currentTime
        })
        return jsonResponse({ review: result }, 200)
      } else {
        const result = await moderateProductReview(context.database, {
          reviewId,
          actorId: claims.identityId,
          action: body.action ?? 'approve',
          reason: body.reason ?? 'Revisión administrativa',
          expectedVersion: body.expectedVersion ?? 0,
          commandId: body.commandId ?? crypto.randomUUID(),
          now: currentTime
        })
        return jsonResponse({ review: result }, 200)
      }
    }

    // 9. POST /api/admin/questions/:questionId/commands (admin: moderate or answer)
    const adminQCmdMatch = /^\/api\/admin\/questions\/([^/]+)\/commands$/.exec(pathname)
    if (adminQCmdMatch && method === 'POST') {
      const claims = await context.sessionClaimsResolver(request)
      if (!claims) return errorResponse('unauthenticated', 401)
      const allowed = await verifyAdminAuthority(context.database, claims.identityId)
      if (!allowed) return errorResponse('forbidden', 403)

      const body = (await request.json().catch(() => null)) as AdminQuestionCommandBody | null
      if (!body) return errorResponse('invalid_input', 400)

      const questionId = adminQCmdMatch[1]!
      if (body.officialAnswer) {
        const result = await officialAnswerProductQuestion(context.database, {
          questionId,
          actorId: claims.identityId,
          officialAnswer: body.officialAnswer,
          expectedVersion: body.expectedVersion ?? 0,
          commandId: body.commandId ?? crypto.randomUUID(),
          now: currentTime
        })
        return jsonResponse({ question: result }, 200)
      } else {
        const result = await moderateProductQuestion(context.database, {
          questionId,
          actorId: claims.identityId,
          action: body.action ?? 'approve',
          reason: body.reason ?? 'Revisión administrativa',
          expectedVersion: body.expectedVersion ?? 0,
          commandId: body.commandId ?? crypto.randomUUID(),
          now: currentTime
        })
        return jsonResponse({ question: result }, 200)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof ProductReviewsQaError) {
      const statusMap: Record<ProductReviewsQaError['code'], number> = {
        invalid_input: 400,
        unauthorized: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409,
        duplicate_submission: 409
      }
      return errorResponse(error.code, statusMap[error.code] ?? 400)
    }
    return errorResponse('internal_error', 500)
  }
}
