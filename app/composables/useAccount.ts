import type { OrderReorderOffer } from '~~/shared/order-reorder'

/**
 * Tipos y utilidades compartidas del área de cliente.
 *
 * Antes vivían dentro de la única página de 583 líneas. Al partir el área en siete
 * rutas, cada una carga solo su recurso: `/cuenta/pedidos` ya no descarga direcciones,
 * sesiones, preferencias, privacidad y favoritos para enseñar una lista de pedidos.
 */

export interface OrderSummary {
  id: string
  status: string
  total: number
  createdAt: string
  lines: number
  /** Omitted by the Node API; false while the D1 invoice/full-detail routes are unavailable. */
  invoiceAvailable?: boolean
  fullDetailAvailable?: boolean
}

export interface AccountProfile {
  name: string | null
  phone: string | null
  email: string
  company: string | null
  tradeName: string | null
  taxId: string | null
  countryCode: string | null
  companyStatus: string | null
  companyRole: string | null
}

export interface Address {
  id: string
  kind: 'shipping' | 'billing' | 'both'
  label: string
  recipientName: string
  companyName: string | null
  taxId: string | null
  line1: string
  line2: string | null
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone: string | null
  instructions: string | null
  isDefault: boolean
}

export interface AccountSession {
  id: string
  mfaVerified: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

export interface Preference {
  purpose: 'newsletter' | 'product_updates' | 'replenishment' | 'transactional'
  channel: 'email' | 'sms' | 'whatsapp'
  enabled: boolean
  frequency: 'immediate' | 'weekly' | 'monthly'
  topics: string[]
}

export interface PrivacyRequest {
  id: string
  requestType: 'export' | 'anonymize'
  status: string
  requestedAt: string
  dueAt: string
  completedAt: string | null
}

export interface FavoriteList {
  id: string
  name: string
  items: Array<{ variantId: string; sku: string; quantity: string; name: string; slug: string; available: boolean }>
}

export interface OrderLine {
  sku: string
  name: string
  format: string
  quantity: number
  unitGross: number
  lineGross: number
  variantId: number | null
  slug: string | null
  image: string | null
  imageAlt?: string | null
  visual: { type: string; color: string } | null
  available: boolean
  reason: string | null
  reorderOffer?: OrderReorderOffer | null
}

/** Contenido de un pedido: alimenta el desplegable del listado y el diálogo de recompra. */
export interface OrderDetailLines {
  orderId: string
  orderedAt: string
  shippingMethod: string
  paymentMethod: string | null
  fulfillmentStatus: string | null
  destination: { line1: string | null; postalCode: string | null; city: string } | null
  totals: { subtotalNet: number; shippingNet: number; tax: number; total: number }
  shipment: { status: string; trackingNumber: string | null; provider: string; updatedAt: string } | null
  lines: OrderLine[]
}

/**
 * Estados de expedición traducidos. La base guarda `in_transit`, `packed`… y eso no se
 * le enseña a un cliente.
 */
export const FULFILLMENT_STATUS: Record<string, { label: string; icon: string }> = {
  pending: { label: 'Pendiente de preparar', icon: 'i-lucide-clock' },
  picking: { label: 'Preparando el pedido', icon: 'i-lucide-package' },
  packed: { label: 'Empaquetado', icon: 'i-lucide-package-check' },
  ready_for_pickup: { label: 'Listo para recoger', icon: 'i-lucide-store' },
  in_transit: { label: 'En reparto', icon: 'i-lucide-truck' },
  delivered: { label: 'Entregado', icon: 'i-lucide-check-check' },
  exception: { label: 'Incidencia en la entrega', icon: 'i-lucide-triangle-alert' },
  returned: { label: 'Devuelto', icon: 'i-lucide-undo-2' }
}

/**
 * Etiquetas de los valores que antes se pintaban crudos de la base de datos.
 * El cliente veía literalmente «Estado: pending · company_admin» y
 * «export · pending» dentro de una interfaz en castellano.
 */
export const COMPANY_STATUS: Record<string, { label: string; color: 'neutral' | 'warning' | 'success' | 'error' }> = {
  pending: { label: 'En revisión', color: 'warning' },
  approved: { label: 'Aprobada', color: 'success' },
  active: { label: 'Activa', color: 'success' },
  rejected: { label: 'No aprobada', color: 'error' },
  suspended: { label: 'Suspendida', color: 'error' }
}

export const COMPANY_ROLE: Record<string, string> = {
  company_admin: 'Administrador de la cuenta',
  company_buyer: 'Comprador',
  company_viewer: 'Solo consulta'
}

export const PRIVACY_REQUEST_TYPE: Record<string, string> = {
  export: 'Exportación de datos',
  anonymize: 'Anonimización'
}

export const PRIVACY_REQUEST_STATUS: Record<string, { label: string; color: 'neutral' | 'warning' | 'success' }> = {
  pending: { label: 'En curso', color: 'warning' },
  processing: { label: 'En curso', color: 'warning' },
  completed: { label: 'Completada', color: 'success' },
  rejected: { label: 'Rechazada', color: 'neutral' }
}

/**
 * Estado compartido de aviso/error de los formularios del área de cliente.
 * Evita repetir el trío `notice` / `errorMessage` / `busy` en siete páginas.
 */
export function useAccountFeedback() {
  const notice = ref('')
  const errorMessage = ref('')
  const busy = ref(false)

  function showError(error: unknown, fallback: string) {
    const candidate = error as { data?: { statusMessage?: string } }
    errorMessage.value = candidate.data?.statusMessage ?? fallback
    notice.value = ''
  }

  function showNotice(message: string) {
    notice.value = message
    errorMessage.value = ''
  }

  /** Envuelve una acción de formulario con estado de carga y captura de error. */
  async function run(action: () => Promise<void>, fallback: string) {
    busy.value = true
    errorMessage.value = ''
    try {
      await action()
    } catch (error) {
      showError(error, fallback)
    } finally {
      busy.value = false
    }
  }

  return { notice, errorMessage, busy, showError, showNotice, run }
}

/**
 * Poblaciones de la instantánea del pedido. Llegan tal y como las escribió el cliente al
 * comprar —«ontinyent», «XATIVA»—, y en pantalla se leían como un error de la tienda.
 */
export function formatPlace(value: string | null | undefined) {
  if (!value) return ''
  return value
    .toLocaleLowerCase('es-ES')
    .split(/(\s|-|')/)
    .map((part) => (/^[a-záéíóúüñ]/.test(part) ? part.charAt(0).toLocaleUpperCase('es-ES') + part.slice(1) : part))
    .join('')
}

export function formatAccountDate(value: string) {
  return new Date(value).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatAccountDateTime(value: string) {
  return new Date(value).toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
