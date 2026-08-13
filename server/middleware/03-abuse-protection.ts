import { enforceRateLimit } from '../utils/rate-limit'

interface LimitRule {
  scope: string
  limit: number
  windowSeconds: number
}

function rule(method: string, path: string): LimitRule | null {
  if (method === 'GET' && path === '/api/search') return { scope: 'search', limit: 60, windowSeconds: 60 }
  if (path.startsWith('/api/cart')) return { scope: 'cart', limit: 120, windowSeconds: 60 }
  if (method === 'POST' && path === '/api/orders') return { scope: 'order-create', limit: 10, windowSeconds: 600 }
  if (method === 'POST' && path === '/api/checkout/pay') return { scope: 'checkout-pay', limit: 10, windowSeconds: 600 }
  if (path === '/api/payments/redsys/notification') return { scope: 'redsys-webhook', limit: 120, windowSeconds: 60 }
  if (path.startsWith('/api/admin')) return { scope: 'admin-api', limit: 300, windowSeconds: 60 }
  return null
}

export default defineEventHandler(async (event) => {
  const selected = rule(event.method.toUpperCase(), getRequestURL(event).pathname)
  if (!selected) return
  const subject =
    getCookie(event, 'neteco-session') ?? getCookie(event, 'neteco-cart') ?? getHeader(event, 'user-agent') ?? ''
  await enforceRateLimit(event, { ...selected, subject })
})
