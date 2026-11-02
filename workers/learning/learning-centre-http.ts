import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createLearningCourseAdmin,
  createLearningLessonAdmin,
  getCourseWithProgress,
  getLearningCertificateByCode,
  issueInternalCertificate,
  listPublicCourses,
  submitLessonQuiz,
  LearningCentreError
} from './learning-centre'
import type { CreateCourseInput, CreateLessonInput } from '../../shared/learning-centre'

export interface LearningActorClaims {
  identityId: string
  customerId?: string | null
  sessionId?: string
  sessionVersion?: number
}

export interface LearningCentreHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  origin: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<LearningActorClaims | null>
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive'
}

export function ownsLearningCentreNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/learning(?:\/|$)/.test(value) || /^\/api\/admin\/learning(?:\/|$)/.test(value)) {
      return true
    }
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return false
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: SECURITY_HEADERS
  })
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code } }, status)
}

function serverNow(deps: LearningCentreHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function resolveClaims(
  request: Request,
  deps: LearningCentreHttpDependencies
): Promise<LearningActorClaims | null> {
  if (deps.claimsResolver) return deps.claimsResolver(request)
  if (!deps.sessionCookieConfiguration) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null
  const identity = await deps.database
    .prepare('SELECT id, customer_id, status FROM identities WHERE id = ?1 AND status = "active"')
    .bind(claims.identityId)
    .first<{ id: string; customer_id: string | null; status: string }>()
  if (!identity) return null
  return {
    identityId: identity.id,
    customerId: identity.customer_id ?? identity.id,
    sessionId: claims.sessionId,
    sessionVersion: claims.sessionVersion
  }
}

export async function handleLearningCentreHttp(
  request: Request,
  deps: LearningCentreHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsLearningCentreNamespace(path)) return null

  const method = request.method
  const now = serverNow(deps)

  try {
    // 1. GET /api/learning/courses
    if (method === 'GET' && path === '/api/learning/courses') {
      const sector = url.searchParams.get('sector') || undefined
      const category = url.searchParams.get('category') || undefined
      const courses = await listPublicCourses(deps.database, { sector, category })
      return jsonResponse({ courses })
    }

    // 2. GET /api/learning/certificates/:code
    const certMatch = path.match(/^\/api\/learning\/certificates\/([a-zA-Z0-9_-]+)$/)
    if (method === 'GET' && certMatch) {
      const code = certMatch[1]!
      const cert = await getLearningCertificateByCode(deps.database, code)
      if (!cert) return errorResponse('not_found', 404)
      return jsonResponse({ certificate: cert })
    }

    // 3. GET /api/learning/courses/:slug
    const courseMatch = path.match(/^\/api\/learning\/courses\/([a-zA-Z0-9_-]+)$/)
    if (method === 'GET' && courseMatch) {
      const slug = courseMatch[1]!
      const claims = await resolveClaims(request, deps)
      const course = await getCourseWithProgress(deps.database, slug, claims?.customerId ?? undefined)
      return jsonResponse({ course })
    }

    // 4. POST /api/learning/lessons/:id/quiz
    const quizMatch = path.match(/^\/api\/learning\/lessons\/([a-zA-Z0-9_-]+)\/quiz$/)
    if (method === 'POST' && quizMatch) {
      const lessonId = quizMatch[1]!
      const claims = await resolveClaims(request, deps)
      if (!claims?.customerId) return errorResponse('unauthorized', 401)
      const body = (await request.json().catch(() => ({}))) as { answers?: Record<string, string> }
      const res = await submitLessonQuiz(deps.database, {
        customerId: claims.customerId,
        lessonId,
        answers: body.answers ?? {},
        now
      })
      return jsonResponse(res)
    }

    // 5. POST /api/learning/courses/:id/certificate
    const issueCertMatch = path.match(/^\/api\/learning\/courses\/([a-zA-Z0-9_-]+)\/certificate$/)
    if (method === 'POST' && issueCertMatch) {
      const courseId = issueCertMatch[1]!
      const claims = await resolveClaims(request, deps)
      if (!claims?.customerId) return errorResponse('unauthorized', 401)
      const body = (await request.json().catch(() => ({}))) as {
        recipientName?: string
        companyName?: string
      }
      if (!body.recipientName) return errorResponse('invalid_input', 400)
      const cert = await issueInternalCertificate(deps.database, {
        customerId: claims.customerId,
        courseId,
        recipientName: body.recipientName,
        companyName: body.companyName,
        now
      })
      return jsonResponse({ certificate: cert }, 201)
    }

    // 6. Admin endpoints: requireAdmin
    if (path.startsWith('/api/admin/learning/')) {
      const claims = await resolveClaims(request, deps)
      if (!claims) return errorResponse('unauthorized', 401)

      // POST /api/admin/learning/courses
      if (method === 'POST' && path === '/api/admin/learning/courses') {
        const body = (await request.json().catch(() => ({}))) as CreateCourseInput
        const course = await createLearningCourseAdmin(deps.database, {
          actorId: claims.identityId,
          input: body,
          now
        })
        return jsonResponse({ course }, 201)
      }

      // POST /api/admin/learning/lessons
      if (method === 'POST' && path === '/api/admin/learning/lessons') {
        const body = (await request.json().catch(() => ({}))) as CreateLessonInput
        const lesson = await createLearningLessonAdmin(deps.database, {
          actorId: claims.identityId,
          input: body,
          now
        })
        return jsonResponse({ lesson }, 201)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof LearningCentreError) {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        unauthorized: 401,
        not_found: 404,
        slug_conflict: 409,
        duplicate_lesson_order: 409,
        course_incomplete: 422,
        already_certified: 409,
        version_conflict: 409,
        invalid_input: 400
      }
      return errorResponse(error.code, statusMap[error.code] ?? 400)
    }
    return errorResponse('internal_error', 500)
  }
}
