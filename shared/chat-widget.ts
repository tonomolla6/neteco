/**
 * Chat flotante de un proveedor externo.
 *
 * La tienda no tiene chat propio: deja un hueco para el script de un proveedor. Sin
 * configuración no se carga nada. Con ella, el script se inyecta en el navegador con el
 * nonce de la CSP y, si el proveedor usa cookies (lo normal), solo después del
 * consentimiento de marketing.
 *
 * Configuración (`runtimeConfig.public.commercial`):
 * - `COMMERCIAL_CHAT_WIDGET_SRC`: URL https del script del proveedor.
 * - `COMMERCIAL_CHAT_WIDGET_ID`: identificador del sitio en el proveedor (`data-widget-id`).
 * - `COMMERCIAL_CHAT_WIDGET_COOKIES`: `false` solo si el proveedor no usa cookies ni almacenamiento.
 *
 * La CSP no conoce ningún dominio de proveedor. Los orígenes que el chat necesite (script,
 * conexiones, iframes, imágenes) se declaran en `CSP_CHAT_WIDGET_ORIGINS`, separados por comas,
 * en el entorno de Nuxt y en el del Worker de la tienda.
 */

export interface ChatWidgetConfig {
  src: string
  id: string
  origin: string
  requiresConsent: boolean
}

export function parseChatWidget(raw: unknown): ChatWidgetConfig | null {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const src = typeof input.chatWidgetSrc === 'string' ? input.chatWidgetSrc.trim() : ''
  if (!src) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const id = typeof input.chatWidgetId === 'string' ? input.chatWidgetId.trim().slice(0, 120) : ''
  const cookies = input.chatWidgetCookies
  return {
    src: url.href,
    id,
    origin: url.origin,
    requiresConsent: !(cookies === false || cookies === 'false')
  }
}

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i

/** Orígenes https desnudos (sin ruta, comodines ni palabras clave) para añadir a la CSP. */
export function parseCspOrigins(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((value) => value.trim())
        .filter((value) => ORIGIN.test(value))
    )
  ]
}
