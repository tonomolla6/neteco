export function canonicalAddress(value: string | null) {
  if (!value || value.length > 45) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split('.').map(Number)
    return octets.every((octet) => octet <= 255) ? octets.join('.') : null
  }
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return null
  try {
    return new URL(`http://[${value}]/`).hostname
  } catch {
    return null
  }
}

/** Only for ingress directly behind Cloudflare's trusted header boundary.
 * No X-Forwarded-For fallback. Native rate limits are per-location/best-effort,
 * not accounting quotas. Never log the address or secret-derived key.
 */
export async function checkAdministrativeEdgeLimit(
  request: Request,
  limiter: RateLimit,
  pepper: string,
  scope:
    | 'admin-media'
    | 'admin-orders'
    | 'admin-returns'
    | 'customer-returns'
    | 'admin-catalog'
    | 'admin-pricing'
    | 'admin-inventory'
    | 'admin-fulfillment'
    | 'admin-cms'
    | 'admin-fiscal'
    | 'admin-analytics'
    | 'client-analytics'
    | 'admin-refunds'
    | 'customer-refunds'
    | 'admin-support'
    | 'admin-sales-quotes'
    | 'customer-sales-quotes'
    | 'admin-customer-context'
    | 'admin-product-contributions'
    | 'product-contributions'
    | 'admin-communication-history'
    | 'admin-capabilities'
    | 'admin-invitations'
    | 'admin-audit'
    | 'administrative-order-views'
    | 'customer-support'
    | 'support-contact'
    | 'support-scanner'
    | 'authentication'
    | 'storefront-cart'
    | 'storefront-shipping'
    | 'storefront-checkout'
    | 'storefront-payment'
    | 'storefront-fiscal'
    | 'storefront-fulfillment'
    | 'shipping-ops'
    | 'support-live-chat'
    | 'admin-crm'
    | 'customer-crm'
    | 'admin-payment-funnel'
    | 'admin-payment-preauth'
    | 'admin-marketing-automations'
    | 'newsletter' = 'admin-media'
): Promise<'allowed' | 'limited' | 'unavailable'> {
  const address = canonicalAddress(request.headers.get('cf-connecting-ip'))
  if (!address || typeof pepper !== 'string' || pepper.length < 32 || pepper.startsWith('local-only-'))
    return 'unavailable'
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pepper),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`neteco:${scope}:edge:v1:${address}`))
    const subject = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const outcome = await limiter.limit({ key: subject })
    return outcome.success === true ? 'allowed' : outcome.success === false ? 'limited' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
