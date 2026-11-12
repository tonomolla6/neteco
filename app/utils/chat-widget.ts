import type { ChatWidgetConfig } from '~~/shared/chat-widget'

/**
 * Inyecta una sola vez el script del chat externo. Devuelve `true` si lo ha añadido ahora.
 * Lleva el nonce de la página para que la CSP estricta lo admita.
 */
export function mountChatWidget(
  doc: Document,
  config: ChatWidgetConfig | null,
  consent: { marketing: boolean } | null
): boolean {
  if (!config) return false
  if (config.requiresConsent && !consent?.marketing) return false
  if (doc.querySelector('script[data-chat-widget]')) return false
  const script = doc.createElement('script')
  script.src = config.src
  script.async = true
  script.dataset.chatWidget = ''
  if (config.id) script.dataset.widgetId = config.id
  // Los navegadores ocultan el atributo tras cargar y lo exponen en la propiedad `nonce`.
  const nonced = doc.querySelector<HTMLScriptElement>('script[nonce]')
  const nonce = nonced?.nonce || nonced?.getAttribute('nonce') || ''
  if (nonce) {
    script.nonce = nonce
    script.setAttribute('nonce', nonce)
  }
  doc.body.appendChild(script)
  return true
}
