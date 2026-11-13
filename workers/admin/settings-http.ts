import type { AdminSettings } from '../../shared/admin-settings'
import { readD1AdminCapabilities } from '../auth/admin-capabilities'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'

export interface AdminSettingsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  /** Variables del Worker. Solo se leen interruptores y valores públicos; ningún secreto sale de aquí. */
  variables: Record<string, unknown>
}

const on = (value: unknown) => value === true || value === 'true'
const text = (value: unknown, max = 160) => (typeof value === 'string' && value.length <= max ? value.trim() : '')
const set = (value: unknown) => typeof value === 'string' && value.trim().length > 0
const stage = (value: unknown): 'sandbox' | 'production' | 'unknown' =>
  value === 'sandbox' || value === 'production' ? value : 'unknown'

/** Proyección de solo lectura de la configuración efectiva; ver `shared/admin-settings.ts`. */
export function adminSettingsFromVariables(variables: Record<string, unknown>): AdminSettings {
  const auth = on(variables.AUTH_ENABLED)
  return {
    source: 'cloudflare',
    environment: text(variables.APP_ENV, 40) || 'unknown',
    demo: on(variables.DEMO_ENABLED),
    payments: {
      cardEnabled: on(variables.REDSYS_ENABLED),
      cardEnvironment: stage(variables.REDSYS_ENVIRONMENT),
      cardCredentialsSet:
        set(variables.REDSYS_MERCHANT_CODE) && set(variables.REDSYS_TERMINAL) && set(variables.REDSYS_SECRET_KEY),
      bizumEnabled: on(variables.REDSYS_ENABLED) && on(variables.REDSYS_BIZUM_ENABLED),
      refundsEnabled: on(variables.REFUNDS_ENABLED),
      storeCreditEnabled: on(variables.STORE_CREDIT_REDEMPTION_ENABLED)
    },
    billing: {
      invoicingEnabled: on(variables.FISCAL_ISSUANCE_ENABLED),
      providerEnabled: on(variables.BEPLY_ENABLED),
      providerEnvironment: stage(variables.BEPLY_ENVIRONMENT),
      invoiceSeries: text(variables.BEPLY_INVOICE_SERIES, 40),
      correctiveSeries: text(variables.BEPLY_CORRECTIVE_SERIES, 40),
      taxRatesMapped: (['0', '10', '21'] as const).filter((rate) => set(variables[`BEPLY_TAX_CODE_${rate}`])),
      creditNotesEnabled: on(variables.CREDIT_DISPATCH_ENABLED)
    },
    email: {
      orderEmailsEnabled: on(variables.TRANSACTIONAL_EMAIL_ENABLED),
      orderEmailsFrom: text(variables.TRANSACTIONAL_EMAIL_FROM),
      accountEmailsEnabled: auth && on(variables.AUTH_EMAIL_ENABLED),
      accountEmailsFrom: text(variables.AUTH_EMAIL_FROM),
      invoiceEmailsEnabled: on(variables.INVOICE_EMAIL_ENABLED),
      newsletterEnabled: on(variables.NEWSLETTER_ENABLED),
      newsletterSendingEnabled: on(variables.NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED),
      newsletterFrom: text(variables.NEWSLETTER_EMAIL_FROM),
      stockAlertsEnabled: auth && on(variables.INVENTORY_ALERTS_ENABLED),
      cartRecoveryEnabled: on(variables.CART_RECOVERY_ENABLED) && on(variables.CART_RECOVERY_DELIVERY_ENABLED)
    },
    services: {
      support: on(variables.SUPPORT_ENABLED),
      supportAttachments: on(variables.SUPPORT_ENABLED) && on(variables.SUPPORT_ATTACHMENTS_ENABLED),
      analytics: on(variables.ANALYTICS_ENABLED),
      newsletter: on(variables.NEWSLETTER_ENABLED),
      newsletterEditorial: on(variables.NEWSLETTER_EDITORIAL_ENABLED),
      quotes: on(variables.SALES_QUOTES_ENABLED),
      reviews: on(variables.PRODUCT_CONTRIBUTIONS_ENABLED),
      media: on(variables.MEDIA_PUBLIC_ENABLED) && on(variables.MEDIA_ADMIN_ENABLED),
      content: on(variables.CMS_PUBLICATION_ENABLED),
      publicApi: auth && on(variables.B2B_PUBLIC_API_ENABLED)
    }
  }
}

/** GET /api/admin/settings: misma puerta que el resto del panel (sesión propia, permiso de administración). */
export async function handleAdminSettingsHttp(
  request: Request,
  deps: AdminSettingsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/admin/settings') return null
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(value, {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        ...headers
      }
    })
  const error = (code: string, status: number, headers: Record<string, string> = {}) =>
    json({ error: { code } }, status, headers)
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' })
  if (url.search) return error('invalid_input', 400)
  try {
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable', 503)
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const capabilities = await readD1AdminCapabilities(deps.database, claims)
    if (!capabilities) return error('unauthenticated', 401)
    if (capabilities.state !== 'ready' || !capabilities.permissions.includes('administration.manage'))
      return error('forbidden', 403)
    return json(adminSettingsFromVariables(deps.variables))
  } catch {
    return error('unavailable', 503)
  }
}
