import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  SANDBOX_PROVIDERS,
  SandboxContractRunInputSchema,
  type SandboxProvider
} from '../../shared/integration-sandbox-contracts'
import {
  FaultInjectionScenarioInputSchema,
  FaultRuleInputSchema,
  type FaultProvider
} from '../../shared/integration-fault-injection'
import {
  CreateWebhookSubscriptionInputSchema,
  RotateSecretInputSchema,
  UpdateWebhookSubscriptionInputSchema,
  type WebhookDeliveryStatus
} from '../../shared/outbound-webhooks'
import {
  acknowledgeDriftAlert,
  executeSandboxContractRun,
  getSandboxContractQuotas,
  listDriftAlerts,
  listSandboxContractRuns,
  SandboxContractsError
} from './sandbox-contracts'
import {
  configureFaultRule,
  FaultInjectionError,
  getFaultSimulationLogs,
  listFaultRules,
  runFaultInjectionSimulation,
  verifyEntityConsistency
} from './fault-injection'
import {
  createWebhookSubscription,
  dispatchWebhookDeliveriesBatch,
  getWebhookDeliveryLogs,
  getWebhookSubscription,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  replayDeadLetterDelivery,
  rotateWebhookSubscriptionSecret,
  updateWebhookSubscription,
  WebhooksError
} from './outbound-webhooks'

export interface IntegrationsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  now?: string | (() => string)
}

export function ownsIntegrationsNamespace(pathname: string): boolean {
  let value = pathname
  for (let depth = 0; depth < 5; depth++) {
    if (
      value.startsWith('/api/admin/sandbox-contracts') ||
      value.startsWith('/api/admin/fault-injection') ||
      value.startsWith('/api/admin/webhooks') ||
      value.startsWith('/api/admin/integraciones') ||
      value.startsWith('/api/admin/integrations')
    ) {
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

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

async function checkIntegrationsPermission(
  db: D1Database,
  claims: { sessionId: string; identityId: string; sessionVersion: number },
  now: string
): Promise<{ allowed: boolean; code?: string }> {
  const authInt = await authorizeD1Session(db, claims, 'integrations.manage', {
    requireMfa: true,
    now
  })
  if (authInt.allowed) return { allowed: true }

  const authAdmin = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    now
  })
  if (authAdmin.allowed) return { allowed: true }

  const code =
    authInt.code === 'mfa_required' || authAdmin.code === 'mfa_required'
      ? 'mfa_required'
      : authInt.code === 'unauthenticated' || authAdmin.code === 'unauthenticated'
        ? 'unauthenticated'
        : 'forbidden'
  return { allowed: false, code }
}

export async function handleIntegrationsHttp(
  request: Request,
  deps: IntegrationsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsIntegrationsNamespace(pathname)) return null

  if (!deps.sessionCookieConfiguration) {
    return errorResponse('service_unavailable', 503)
  }

  const now =
    typeof deps.now === 'function' ? deps.now() : (deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))

  // CSRF validation on mutating methods
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method) && deps.origin) {
    const requestOrigin = request.headers.get('origin')
    if ((requestOrigin && requestOrigin !== deps.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return errorResponse('csrf_rejected', 403)
    }
  }

  // Verificar sesión
  const session = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!session) {
    return errorResponse('unauthenticated', 401)
  }

  // Verificar permisos de administración o integraciones con MFA
  const auth = await checkIntegrationsPermission(deps.database, session, now)
  if (!auth.allowed) {
    const status = auth.code === 'unauthenticated' ? 401 : 403
    return errorResponse(auth.code ?? 'forbidden', status)
  }

  try {
    // -------------------------------------------------------------------------
    // RESUMEN / OVERVIEW GLOBAL (AdminIntegrationsDashboard.vue)
    // -------------------------------------------------------------------------
    if (
      request.method === 'GET' &&
      (pathname === '/api/admin/integrations/summary' ||
        pathname === '/api/admin/integrations/overview' ||
        pathname === '/api/admin/integraciones/summary' ||
        pathname === '/api/admin/integraciones')
    ) {
      const [quotas, runs, alerts, rules, subscriptions, deliveries] = await Promise.all([
        Promise.all(SANDBOX_PROVIDERS.map((p) => getSandboxContractQuotas(deps.database, p, now))),
        listSandboxContractRuns(deps.database),
        listDriftAlerts(deps.database),
        listFaultRules(deps.database),
        listWebhookSubscriptions(deps.database),
        listWebhookDeliveries(deps.database, { limit: 50 })
      ])

      return jsonResponse({
        quotas,
        runs,
        alerts,
        rules,
        subscriptions,
        deliveries
      })
    }

    // -------------------------------------------------------------------------
    // INT-018: SANDBOX CONTRACTS
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/admin/sandbox-contracts')) {
      // GET /api/admin/sandbox-contracts/quotas
      if (request.method === 'GET' && pathname === '/api/admin/sandbox-contracts/quotas') {
        const quotas = await Promise.all(SANDBOX_PROVIDERS.map((p) => getSandboxContractQuotas(deps.database, p, now)))
        return jsonResponse({ quotas })
      }

      // GET /api/admin/sandbox-contracts/runs
      if (request.method === 'GET' && pathname === '/api/admin/sandbox-contracts/runs') {
        const provider = url.searchParams.get('provider') as SandboxProvider | null
        const runs = await listSandboxContractRuns(deps.database, provider ? { provider } : undefined)
        return jsonResponse({ runs })
      }

      // POST /api/admin/sandbox-contracts/run
      if (request.method === 'POST' && pathname === '/api/admin/sandbox-contracts/run') {
        const raw = await request.json().catch(() => null)
        const parsed = SandboxContractRunInputSchema.parse(raw)
        const summary = await executeSandboxContractRun(deps.database, parsed, {
          actorId: session.identityId,
          now
        })
        return jsonResponse(summary, 200)
      }

      // GET /api/admin/sandbox-contracts/drift-alerts
      if (request.method === 'GET' && pathname === '/api/admin/sandbox-contracts/drift-alerts') {
        const acknowledgedParam = url.searchParams.get('acknowledged')
        const acknowledged = acknowledgedParam === 'true' ? true : acknowledgedParam === 'false' ? false : undefined
        const alerts = await listDriftAlerts(deps.database, acknowledged !== undefined ? { acknowledged } : undefined)
        return jsonResponse({ alerts })
      }

      // POST /api/admin/sandbox-contracts/drift-alerts/:id/acknowledge
      const ackMatch = /^\/api\/admin\/sandbox-contracts\/drift-alerts\/([^/]+)\/acknowledge$/.exec(pathname)
      if (request.method === 'POST' && ackMatch) {
        const alertId = ackMatch[1]!
        const alert = await acknowledgeDriftAlert(deps.database, alertId, {
          actorId: session.identityId,
          now
        })
        return jsonResponse(alert)
      }
    }

    // -------------------------------------------------------------------------
    // INT-019: FAULT INJECTION
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/admin/fault-injection')) {
      // GET /api/admin/fault-injection/rules
      if (request.method === 'GET' && pathname === '/api/admin/fault-injection/rules') {
        const provider = url.searchParams.get('provider') as FaultProvider | null
        const rules = await listFaultRules(deps.database, provider ?? undefined)
        return jsonResponse({ rules })
      }

      // POST /api/admin/fault-injection/rules
      if (request.method === 'POST' && pathname === '/api/admin/fault-injection/rules') {
        const raw = await request.json()
        const parsed = FaultRuleInputSchema.parse(raw)
        const rule = await configureFaultRule(deps.database, parsed, {
          actorId: session.identityId,
          now
        })
        return jsonResponse(rule, 201)
      }

      // POST /api/admin/fault-injection/simulate
      if (request.method === 'POST' && pathname === '/api/admin/fault-injection/simulate') {
        const raw = await request.json()
        const parsed = FaultInjectionScenarioInputSchema.parse(raw)
        const result = await runFaultInjectionSimulation(deps.database, parsed, {
          actorId: session.identityId,
          now
        })
        return jsonResponse(result, 200)
      }

      // GET /api/admin/fault-injection/logs
      if (request.method === 'GET' && pathname === '/api/admin/fault-injection/logs') {
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam ? parseInt(limitParam, 10) : 50
        const logs = await getFaultSimulationLogs(deps.database, limit)
        return jsonResponse({ logs })
      }

      // GET /api/admin/fault-injection/consistency/:entityId
      const consistencyMatch = /^\/api\/admin\/fault-injection\/consistency\/([^/]+)$/.exec(pathname)
      if (request.method === 'GET' && consistencyMatch) {
        const entityId = consistencyMatch[1]!
        const check = await verifyEntityConsistency(deps.database, entityId)
        return jsonResponse(check)
      }
    }

    // -------------------------------------------------------------------------
    // INT-021: OUTBOUND WEBHOOKS
    // -------------------------------------------------------------------------
    if (pathname.startsWith('/api/admin/webhooks')) {
      // GET /api/admin/webhooks/subscriptions
      if (request.method === 'GET' && pathname === '/api/admin/webhooks/subscriptions') {
        const subscriptions = await listWebhookSubscriptions(deps.database)
        return jsonResponse({ subscriptions })
      }

      // POST /api/admin/webhooks/subscriptions
      if (request.method === 'POST' && pathname === '/api/admin/webhooks/subscriptions') {
        const raw = await request.json()
        const parsed = CreateWebhookSubscriptionInputSchema.parse(raw)
        const sub = await createWebhookSubscription(deps.database, parsed, {
          ownerId: session.identityId,
          now
        })
        return jsonResponse(sub, 201)
      }

      // POST /api/admin/webhooks/subscriptions/:id/rotate-secret
      const rotateMatch = /^\/api\/admin\/webhooks\/subscriptions\/([^/]+)\/rotate-secret$/.exec(pathname)
      if (request.method === 'POST' && rotateMatch) {
        const subId = rotateMatch[1]!
        const raw = await request.json()
        const parsed = RotateSecretInputSchema.parse(raw)
        const rotated = await rotateWebhookSubscriptionSecret(deps.database, subId, {
          expectedVersion: parsed.expectedVersion,
          gracePeriodSeconds: parsed.gracePeriodSeconds,
          now
        })
        return jsonResponse(rotated, 200)
      }

      // GET /api/admin/webhooks/subscriptions/:id
      const subMatch = /^\/api\/admin\/webhooks\/subscriptions\/([^/]+)$/.exec(pathname)
      if (request.method === 'GET' && subMatch) {
        const subId = subMatch[1]!
        const sub = await getWebhookSubscription(deps.database, subId)
        return jsonResponse({ subscription: sub })
      }

      // PUT /api/admin/webhooks/subscriptions/:id
      if (request.method === 'PUT' && subMatch) {
        const subId = subMatch[1]!
        const raw = await request.json().catch(() => null)
        const payload = typeof raw === 'object' && raw !== null ? { ...raw, id: subId } : { id: subId }
        const parsed = UpdateWebhookSubscriptionInputSchema.parse(payload)
        const updated = await updateWebhookSubscription(deps.database, parsed, { ownerId: session.identityId, now })
        return jsonResponse(updated, 200)
      }

      // GET /api/admin/webhooks/deliveries
      if (request.method === 'GET' && pathname === '/api/admin/webhooks/deliveries') {
        const subscriptionId = url.searchParams.get('subscriptionId') ?? undefined
        const status = (url.searchParams.get('status') as WebhookDeliveryStatus) ?? undefined
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam ? parseInt(limitParam, 10) : 50
        const deliveries = await listWebhookDeliveries(deps.database, {
          subscriptionId,
          status,
          limit
        })
        return jsonResponse({ deliveries })
      }

      // GET /api/admin/webhooks/deliveries/:id/logs
      const logsMatch = /^\/api\/admin\/webhooks\/deliveries\/([^/]+)\/logs$/.exec(pathname)
      if (request.method === 'GET' && logsMatch) {
        const deliveryId = logsMatch[1]!
        const logs = await getWebhookDeliveryLogs(deps.database, deliveryId)
        return jsonResponse({ logs })
      }

      // POST /api/admin/webhooks/deliveries/:id/replay
      const replayMatch = /^\/api\/admin\/webhooks\/deliveries\/([^/]+)\/replay$/.exec(pathname)
      if (request.method === 'POST' && replayMatch) {
        const deliveryId = replayMatch[1]!
        const replayed = await replayDeadLetterDelivery(deps.database, deliveryId, {
          actorId: session.identityId,
          now
        })
        return jsonResponse(replayed, 200)
      }

      // POST /api/admin/webhooks/dispatch
      if (request.method === 'POST' && pathname === '/api/admin/webhooks/dispatch') {
        const dispatchResult = await dispatchWebhookDeliveriesBatch(deps.database, { now })
        return jsonResponse(dispatchResult, 200)
      }
    }

    return errorResponse('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return jsonResponse({ error: { code: 'invalid_input', issues: err.issues } }, 400)
    }
    if (err instanceof WebhooksError) {
      if (err.code === 'subscription_not_found') return errorResponse('subscription_not_found', 404)
      if (err.code === 'forbidden') return errorResponse('forbidden', 403)
      if (err.code === 'concurrency_conflict') return errorResponse('concurrency_conflict', 409)
      if (err.code.startsWith('https_required')) return errorResponse('https_required', 400)
      return errorResponse(err.code, 400)
    }
    if (err instanceof FaultInjectionError) {
      if (err.code === 'rule_not_found') return errorResponse('rule_not_found', 404)
      if (err.code === 'concurrency_conflict') return errorResponse('concurrency_conflict', 409)
      return errorResponse(err.code, 400)
    }
    if (err instanceof SandboxContractsError) {
      return errorResponse(err.code, 400)
    }

    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: { code: 'internal_error', message } }, 500)
  }
}
