/** Worker-native renderer: no Node/SMTP/template runtime or payment bearer links. */
export interface OrderCreatedEmailSnapshot {
  id: string
  contactName: string | null
  totalGrossCents: number
  shippingGrossCents: number
  lines: { name: string; sku: string; quantity: number; grossCents: number }[]
  /** Server-built, purpose-separated guest view link; never a payment bearer. */
  guestViewUrl?: string
}

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function plain(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}

function euros(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')} €`
}

export function renderOrderCreatedEmail(order: OrderCreatedEmailSnapshot): {
  subject: string
  html: string
  text: string
} {
  const greeting = order.contactName ? `Hola ${plain(order.contactName)},` : 'Hola,'
  const rows = order.lines.map((line) => {
    const label = `${plain(line.name)} (${plain(line.sku)})`
    return {
      html: `<li>${escapeEmailHtml(label)} — ${line.quantity} ud. — ${euros(line.grossCents)}</li>`,
      text: `${label} — ${line.quantity} ud. — ${euros(line.grossCents)}`
    }
  })
  const state =
    'Hemos recibido tu pedido. Al registrarlo, quedó pendiente de pago; este mensaje no confirma el pago ni el envío.'
  let access = ''
  if (order.guestViewUrl !== undefined) {
    const url = new URL(order.guestViewUrl)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `/pedido/${order.id}` ||
      url.searchParams.size !== 1 ||
      !/^[a-f0-9]{64}$/.test(url.searchParams.get('token') ?? '')
    )
      throw new Error('invalid_guest_view_url')
    access =
      'Enlace privado: sólo permite consultar tu pedido durante el plazo original de acceso (máximo 24 horas desde su creación). No permite pagar. Cada acceso dura como máximo 30 minutos y puede revocarse.'
  }
  return {
    subject: `NETECO: pedido recibido ${order.id}`,
    html: `<!doctype html><html lang="es"><body><p>${escapeEmailHtml(greeting)}</p><h1>Pedido recibido</h1><p>${state}</p><p>Referencia: ${escapeEmailHtml(order.id)}</p><ul>${rows.map((row) => row.html).join('')}</ul><p>Envío: ${euros(order.shippingGrossCents)}</p><p>Total (IVA incluido): ${euros(order.totalGrossCents)}</p><p>Conserva esta referencia para consultar tu pedido con NETECO.</p>${access ? `<p>${escapeEmailHtml(access)}</p><p><a href="${escapeEmailHtml(order.guestViewUrl!)}">Consultar pedido</a></p>` : ''}</body></html>`,
    text: `${greeting}\n\n${state}\nReferencia: ${order.id}\n\n${rows.map((row) => row.text).join('\n')}\nEnvío: ${euros(order.shippingGrossCents)}\nTotal (IVA incluido): ${euros(order.totalGrossCents)}\n\nConserva esta referencia para consultar tu pedido con NETECO.${access ? `\n\n${access}\n${order.guestViewUrl}` : ''}`
  }
}
