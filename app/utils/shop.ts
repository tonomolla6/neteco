import type { UiColor } from '~~/shared/types/catalog'

export function formatPrice(cents: number) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

export const BADGES: Record<string, { label: string; color: UiColor; icon: string }> = {
  eco: { label: 'Ecológico', color: 'success', icon: 'i-lucide-leaf' },
  alimentaria: { label: 'Uso alimentario', color: 'warning', icon: 'i-lucide-utensils' },
  concentrado: { label: 'Concentrado', color: 'info', icon: 'i-lucide-flask-conical' }
}

export const ORDER_STATUS: Record<string, { label: string; color: UiColor; icon: string }> = {
  pendiente_pago: { label: 'Pago pendiente', color: 'warning', icon: 'i-lucide-clock' },
  procesando_pago: { label: 'Procesando pago', color: 'info', icon: 'i-lucide-loader-circle' },
  pago_fallido: { label: 'Pago no completado', color: 'error', icon: 'i-lucide-circle-alert' },
  incidencia_stock: { label: 'Incidencia de stock', color: 'warning', icon: 'i-lucide-triangle-alert' },
  pendiente_transferencia: { label: 'Esperando transferencia', color: 'info', icon: 'i-lucide-landmark' },
  pagado: { label: 'Pagado', color: 'success', icon: 'i-lucide-circle-check' },
  reembolso_parcial: { label: 'Reembolso parcial', color: 'warning', icon: 'i-lucide-undo-2' },
  reembolsado: { label: 'Reembolsado', color: 'neutral', icon: 'i-lucide-undo-2' },
  preparando: { label: 'En preparación', color: 'info', icon: 'i-lucide-package' },
  listo_recogida: { label: 'Listo para recoger', color: 'success', icon: 'i-lucide-package-check' },
  enviado: { label: 'Enviado', color: 'info', icon: 'i-lucide-truck' },
  entregado: { label: 'Entregado', color: 'success', icon: 'i-lucide-check-check' },
  cancelado: { label: 'Cancelado', color: 'error', icon: 'i-lucide-circle-x' }
}

export const SHIPPING_METHODS = [
  {
    value: 'reparto',
    label: 'Reparto propio NETECO',
    desc: 'Ontinyent y comarca de la Vall d’Albaida · 24-48 h',
    price: 0
  },
  {
    value: 'envio',
    label: 'Envío por agencia',
    desc: 'Península · 48-72 h',
    price: 590
  },
  {
    value: 'recogida',
    label: 'Recogida en almacén',
    desc: 'Ontinyent · listo en 2 h laborables',
    price: 0
  }
]

// prefijo de CP de la zona de reparto propio (Ontinyent y la Vall d'Albaida)
export const REPARTO_ZIP_PREFIX = '468'

// etiquetas legibles para el filtro por tipo de envase (visual.type)
export const ENVASE_LABELS: Record<string, string> = {
  garrafa: 'Garrafa',
  botella: 'Botella',
  spray: 'Pulverizador',
  caja: 'Caja / pack',
  saco: 'Saco',
  capsulas: 'Cápsulas',
  difusor: 'Difusor / equipo',
  cubo: 'Cubo',
  rollo: 'Bobina / celulosa',
  vaso: 'Vaso',
  guante: 'Guante'
}

// "0.75-L" → "750 ml", "5-L" → "5 L", "100-ud" → "100 uds"
export function formatCapacity(value: string) {
  const m = value.match(/^([\d.]+)-(.+)$/)
  if (!m) return value
  const units = Number(m[1])
  const label = m[2]
  if (label === 'L') return units < 1 ? `${Math.round(units * 1000)} ml` : `${units} L`
  if (label === 'kg') return units < 1 ? `${Math.round(units * 1000)} g` : `${units} kg`
  if (label === 'ud') return `${units} uds`
  return `${units} ${label}`
}

export function formatDate(iso: string) {
  return new Date(iso.includes('T') ? iso : iso + 'Z').toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
