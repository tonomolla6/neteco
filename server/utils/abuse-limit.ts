export interface LimitRule {
  scope: string
  limit: number
  windowSeconds: number
}

export const SENSITIVE_RATE_LIMIT_POLICIES = {
  login: { limit: 5, windowSeconds: 900 },
  register: { limit: 3, windowSeconds: 3600 },
  'forgot-password': { limit: 3, windowSeconds: 3600 },
  'reset-password': { limit: 5, windowSeconds: 900 },
  'verify-email': { limit: 10, windowSeconds: 900 },
  'mfa-complete': { limit: 6, windowSeconds: 300 },
  'mfa-setup': { limit: 6, windowSeconds: 300 },
  'account-password': { limit: 5, windowSeconds: 900 },
  'account-email-change': { limit: 3, windowSeconds: 3600 },
  'professional-account': { limit: 5, windowSeconds: 3600 },
  'newsletter-subscribe': { limit: 3, windowSeconds: 3600 },
  'newsletter-confirm': { limit: 10, windowSeconds: 900 },
  'newsletter-unsubscribe': { limit: 20, windowSeconds: 900 }
} as const

export type SensitiveRateLimitScope = keyof typeof SENSITIVE_RATE_LIMIT_POLICIES

export function sensitiveRateLimit(scope: SensitiveRateLimitScope, subject?: string) {
  return { scope, ...(subject === undefined ? {} : { subject }), ...SENSITIVE_RATE_LIMIT_POLICIES[scope] }
}

export function abuseLimitRule(method: string, path: string): LimitRule | null {
  if (method === 'GET' && path === '/api/search') return { scope: 'search', limit: 60, windowSeconds: 60 }
  if (path.startsWith('/api/cart')) return { scope: 'cart', limit: 120, windowSeconds: 60 }
  if (method === 'POST' && path === '/api/orders') return { scope: 'order-create', limit: 10, windowSeconds: 600 }
  if (method === 'POST' && path === '/api/checkout/pay') return { scope: 'checkout-pay', limit: 10, windowSeconds: 600 }
  if (method === 'POST' && path === '/api/support/tickets')
    return { scope: 'support-contact', limit: 5, windowSeconds: 3600 }
  if (method === 'POST' && path === '/api/analytics/events')
    return { scope: 'analytics-events', limit: 120, windowSeconds: 60 }
  if (path === '/api/payments/redsys/notification') return { scope: 'redsys-webhook', limit: 120, windowSeconds: 60 }
  if (path === '/api/webhooks/email') return { scope: 'email-webhook', limit: 240, windowSeconds: 60 }
  if (method === 'POST' && path === '/api/admin/media')
    return { scope: 'admin-media-upload', limit: 20, windowSeconds: 3600 }
  if (path.startsWith('/api/admin')) return { scope: 'admin-api', limit: 300, windowSeconds: 60 }
  return null
}
