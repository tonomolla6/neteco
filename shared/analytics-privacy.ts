/** Presence, not truthiness: even an empty/invalid preview bearer is private. */
export function isCmsPreviewRoute(path: string, query: object): boolean {
  return /^\/contenido(?:\/|$)/.test(path) && Object.hasOwn(query, 'preview')
}

const privatePath =
  /^\/(?:admin|cuenta|pedido|pedidos|auth|login|registro|recuperar-clave|restablecer-clave|reset|reset-password|verificar-email|newsletter|api|carrito|checkout)(?:\/|$)/i

/** Private pages stay excluded after bearer removal. Cart/checkout events are
 * deliberately excluded too: consented browser funnels are not financial
 * authority. Inspect parameter presence, never bearer/query values. */
export function isPrivateAnalyticsRoute(path: string, query: object): boolean {
  if (typeof path !== 'string' || path.length > 240 || !query || typeof query !== 'object' || Array.isArray(query))
    return true
  let decoded = path
  for (let round = 0; round < 4; round++) {
    if (privatePath.test(decoded) || isCmsPreviewRoute(decoded.toLowerCase(), query)) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return !/^\/[a-zA-Z0-9_/-]*$/.test(decoded)
      decoded = next
    } catch {
      return true
    }
  }
  // An unresolved encoding is not evidence of a public route.
  return true
}
