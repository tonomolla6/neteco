/**
 * Productos publicados sin precio público.
 *
 * Parte del catálogo llega sin tarifa (importado de un catálogo en papel): precio 0 y stock 0.
 * Eso no es «0,00 €» ni «Agotado»: es un producto que se vende, pero cuyo precio se pide.
 * Toda la tienda lo dice igual y lleva al contacto con el producto ya escrito.
 */

export const PRICE_ON_REQUEST = 'Consultar precio'
export const PRICE_REQUEST_ACTION = 'Pedir precio'

/** Un importe en céntimos es precio público solo si es un número finito mayor que cero. */
export function hasPublicPrice(cents: unknown): cents is number {
  return typeof cents === 'number' && Number.isFinite(cents) && cents > 0
}

const SUBJECT_MAX = 200
const MESSAGE_MAX = 600

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
}

/** Enlace a `/contacto` con producto, asunto y mensaje rellenados. */
export function priceRequestPath(item: {
  slug: string
  name: string
  sku?: string | null
  format?: string | null
}): string {
  const reference = item.sku?.trim() || ''
  const format = item.format?.trim() || ''
  const subjectTail = reference ? ` · Ref. ${reference}` : ''
  const subject = `${clip(`Precio de ${item.name}`, SUBJECT_MAX - subjectTail.length)}${subjectTail}`
  const message = clip(
    `Quiero saber el precio de ${item.name}${format ? ` (${format})` : ''}${reference ? `, referencia ${reference}` : ''}.`,
    MESSAGE_MAX
  )
  const query = new URLSearchParams({
    producto: item.slug,
    asunto: subject,
    mensaje: `${message} Cantidad aproximada: `
  })
  return `/contacto?${query.toString()}`
}
