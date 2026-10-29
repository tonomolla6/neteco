/**
 * UUID v4 con reserva para contextos no seguros.
 *
 * `crypto.randomUUID()` **solo existe en contextos seguros**: HTTPS o `localhost`. El
 * código de cliente lo usaba en catorce sitios —claves de idempotencia del carrito y del
 * checkout, solicitudes de privacidad, eventos de analítica— sin reserva, así que al servir
 * la aplicación por HTTP en una IP de red local o de revisión, el `setup` del checkout
 * lanzaba `TypeError` y la página entera caía al error 500. En producción, sobre HTTPS, no
 * se notaba.
 *
 * `crypto.getRandomValues()` sí está disponible en contextos inseguros, así que la reserva
 * mantiene la misma calidad de aleatoriedad; lo único que cambia es cómo se formatea.
 *
 * No se usa `Math.random()` en ningún caso: estas claves evitan que un pedido se duplique.
 */
export function randomId(): string {
  const api = globalThis.crypto
  if (api && typeof api.randomUUID === 'function') return api.randomUUID()

  const bytes = new Uint8Array(16)
  if (api && typeof api.getRandomValues === 'function') {
    api.getRandomValues(bytes)
  } else {
    throw new Error('No hay una fuente de aleatoriedad criptográfica disponible')
  }

  // Versión 4, variante RFC 4122
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join('')
  ].join('-')
}
