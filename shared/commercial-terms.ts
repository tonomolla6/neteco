/**
 * Condiciones comerciales de la tienda, en un solo sitio.
 *
 * Días de ruta, hora de corte, coste del reparto, umbral de envío gratis, pago aplazado:
 * son decisiones del negocio, no del código. Aquí NO hay ningún valor por defecto: cada
 * clave empieza vacía y la tienda solo escribe una promesa concreta cuando el dato está
 * configurado. Sin dato se dice lo que sí es cierto (hay reparto propio en la comarca, hay
 * un teléfono) o no se dice nada. Así ninguna pantalla promete algo que nadie ha decidido.
 *
 * Origen de los valores: `runtimeConfig.public.commercial` (variables `COMMERCIAL_*`, ver
 * `nuxt.config.ts`). El servidor sigue siendo la autoridad del coste y de la fecha de cada
 * pedido; esto es la copia que el cliente lee antes de pedir.
 */

export interface CommercialTerms {
  /** Días de ruta del reparto propio, tal como se leen: «martes y jueves». */
  ownDeliveryDays: string
  /** Hora de corte para entrar en la siguiente ruta, `HH:MM`. */
  orderCutoffTime: string
  /** Coste del reparto propio en céntimos con IVA. `0` es «sin coste»; `null`, desconocido. */
  ownDeliveryCostCents: number | null
  /** Importe desde el que el reparto propio es gratis. */
  ownDeliveryFreeFromCents: number | null
  /** Pedido mínimo del reparto propio, si lo hay. */
  ownDeliveryMinimumOrderCents: number | null
  /** Plazo de la agencia, tal como se lee: «24-48 h». */
  parcelLeadTime: string
  /** Coste de la paquetería estándar por debajo del umbral. */
  parcelCostCents: number | null
  /** Umbral de envío gratis en paquetería estándar (`FREE_SHIPPING_THRESHOLD_CENTS`). */
  parcelFreeFromCents: number | null
  /** Días de pago aplazado para empresas con cuenta aprobada. */
  deferredPaymentDays: number | null
  /** Condiciones del pago aplazado, en una frase. */
  deferredPaymentConditions: string
  /** Horario de atención, tal como se lee: «de lunes a viernes de 9:00 a 18:00». */
  supportHours: string
  /** Número de WhatsApp si se atienden pedidos por ese canal; solo dígitos. */
  whatsappNumber: string
  /** Año de fundación. */
  foundedYear: number | null
  /** Nombre comercial confirmado de la gama ecológica. */
  ecoRangeBrand: string
  /** NIF del titular, para el pie. */
  companyTaxId: string
  /** Domicilio del titular, para el pie. */
  companyAddress: string
  /** Hay certificados reales, con número y documento, cargados y publicables. */
  certificationsPublished: boolean
  /** Único correo de contacto de la tienda. Sin configurar: `tienda@neteco.es`. */
  contactEmail: string
  /** Teléfono de contacto atendido por personas, tal como se lee. Vacío: no se muestra. */
  contactPhone: string
  /** Teléfono de atención con asistente automático, tal como se lee. Vacío: no se muestra. */
  supportPhoneAi: string
  /** Nombre o razón social del titular, para las páginas legales. */
  companyLegalName: string
  /** Datos de inscripción registral (Registro Mercantil u otro registro público), tal como se leen. */
  companyRegistry: string
  /** Correo del delegado de protección de datos o de la dirección de privacidad. Vacío: se usa el de contacto. */
  dpoEmail: string
  /** Entidad de resolución alternativa de litigios a la que está adherida la tienda, si lo está. */
  disputeResolutionEntity: string
}

export const COMMERCIAL_TERM_KEYS = [
  'ownDeliveryDays',
  'orderCutoffTime',
  'ownDeliveryCostCents',
  'ownDeliveryFreeFromCents',
  'ownDeliveryMinimumOrderCents',
  'parcelLeadTime',
  'parcelCostCents',
  'parcelFreeFromCents',
  'deferredPaymentDays',
  'deferredPaymentConditions',
  'supportHours',
  'whatsappNumber',
  'foundedYear',
  'ecoRangeBrand',
  'companyTaxId',
  'companyAddress',
  'certificationsPublished',
  'contactEmail',
  'contactPhone',
  'supportPhoneAi',
  'companyLegalName',
  'companyRegistry',
  'dpoEmail',
  'disputeResolutionEntity'
] as const satisfies ReadonlyArray<keyof CommercialTerms>

export const DEFAULT_CONTACT_EMAIL = 'tienda@neteco.es'
export const OWN_DELIVERY_ZONE = "Ontinyent y la Vall d'Albaida"

const PHONE = /^\+?\d[\d ]{7,17}\d$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function phone(value: unknown): string {
  const clean = text(value, 20)
  return PHONE.test(clean) ? clean : ''
}

function text(value: unknown, max = 160): string {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : ''
}

/** Entero no negativo. Una cadena vacía es «sin dato», nunca cero. */
function integer(value: unknown, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number | null {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const amount = Number(typeof value === 'string' ? value.trim() : value)
  return Number.isSafeInteger(amount) && amount >= min && amount <= max ? amount : null
}

/** Un importe que solo tiene sentido si es mayor que cero (umbrales y mínimos). */
function positive(value: unknown): number | null {
  const amount = integer(value)
  return amount ? amount : null
}

export function parseCommercialTerms(raw: unknown): CommercialTerms {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cutoff = text(input.orderCutoffTime, 5)
  return {
    ownDeliveryDays: text(input.ownDeliveryDays, 80),
    orderCutoffTime: /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(cutoff) ? cutoff : '',
    ownDeliveryCostCents: integer(input.ownDeliveryCostCents),
    ownDeliveryFreeFromCents: positive(input.ownDeliveryFreeFromCents),
    ownDeliveryMinimumOrderCents: positive(input.ownDeliveryMinimumOrderCents),
    parcelLeadTime: text(input.parcelLeadTime, 40),
    parcelCostCents: integer(input.parcelCostCents),
    parcelFreeFromCents: positive(input.parcelFreeFromCents),
    deferredPaymentDays: positive(integer(input.deferredPaymentDays, { max: 365 })),
    deferredPaymentConditions: text(input.deferredPaymentConditions, 240),
    supportHours: text(input.supportHours, 80),
    whatsappNumber: /^\+?[\d ]{9,18}$/.test(text(input.whatsappNumber, 20))
      ? text(input.whatsappNumber, 20).replace(/[^\d]/g, '')
      : '',
    foundedYear: integer(input.foundedYear, { min: 1900, max: 2100 }),
    ecoRangeBrand: text(input.ecoRangeBrand, 40),
    companyTaxId: text(input.companyTaxId, 20),
    companyAddress: text(input.companyAddress, 160),
    certificationsPublished: input.certificationsPublished === true || input.certificationsPublished === 'true',
    contactEmail: EMAIL.test(text(input.contactEmail, 120)) ? text(input.contactEmail, 120) : DEFAULT_CONTACT_EMAIL,
    contactPhone: phone(input.contactPhone),
    supportPhoneAi: phone(input.supportPhoneAi),
    companyLegalName: text(input.companyLegalName, 160),
    companyRegistry: text(input.companyRegistry, 240),
    dpoEmail: EMAIL.test(text(input.dpoEmail, 120)) ? text(input.dpoEmail, 120) : '',
    disputeResolutionEntity: text(input.disputeResolutionEntity, 240)
  }
}

/** «150 €» se lee mejor que «150,00 €»; los céntimos solo salen si existen. */
export function formatCommercialAmount(cents: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  })
    .format(cents / 100)
    .replace(/\u00a0/g, ' ')
}

export interface CommercialPromise {
  key: 'own-delivery' | 'parcel' | 'support' | 'payment'
  icon: string
  title: string
  text: string
  to: string
  /** Lleva al menos un dato configurado por el negocio. */
  concrete: boolean
}

function ownDeliveryCost(terms: CommercialTerms): string {
  const { ownDeliveryCostCents: cost, ownDeliveryFreeFromCents: freeFrom } = terms
  if (cost === 0) return 'Sin coste de reparto.'
  if (cost !== null && freeFrom !== null)
    return `Reparto: ${formatCommercialAmount(cost)}, gratis desde ${formatCommercialAmount(freeFrom)}.`
  if (cost !== null) return `Reparto: ${formatCommercialAmount(cost)}.`
  if (freeFrom !== null) return `Reparto gratis desde ${formatCommercialAmount(freeFrom)}.`
  return ''
}

/** El reparto propio existe: sin datos se afirma solo eso. */
export function ownDeliveryPromise(terms: CommercialTerms): CommercialPromise {
  const parts = [
    terms.ownDeliveryDays
      ? `Reparto propio en ${OWN_DELIVERY_ZONE}: ${terms.ownDeliveryDays}.`
      : `En ${OWN_DELIVERY_ZONE} te lo llevamos nosotros.`,
    terms.orderCutoffTime ? `Pide antes de las ${terms.orderCutoffTime}.` : '',
    ownDeliveryCost(terms),
    terms.ownDeliveryMinimumOrderCents !== null
      ? `Pedido mínimo: ${formatCommercialAmount(terms.ownDeliveryMinimumOrderCents)}.`
      : ''
  ].filter(Boolean)
  return {
    key: 'own-delivery',
    icon: 'i-lucide-truck',
    title: 'Reparto propio',
    text: parts.join(' '),
    to: '/envios',
    concrete: parts.length > 1 || !!terms.ownDeliveryDays
  }
}

/** La agencia solo se anuncia con un plazo o un umbral reales. */
export function parcelPromise(terms: CommercialTerms): CommercialPromise | null {
  const { parcelLeadTime: lead, parcelFreeFromCents: freeFrom, parcelCostCents: cost } = terms
  if (!lead && freeFrom === null && cost === null) return null
  const parts = [
    lead ? `Resto de península en ${lead}.` : 'Envío por agencia al resto de península.',
    cost !== null && cost > 0 ? `Coste: ${formatCommercialAmount(cost)}.` : '',
    freeFrom !== null ? `Gratis desde ${formatCommercialAmount(freeFrom)} en paquetería estándar.` : ''
  ].filter(Boolean)
  return {
    key: 'parcel',
    icon: 'i-lucide-package-check',
    title: 'Envío a península',
    text: parts.join(' '),
    to: '/envios',
    concrete: true
  }
}

export function deferredPaymentPromise(terms: CommercialTerms): string | null {
  return terms.deferredPaymentDays === null
    ? null
    : `Empresas con cuenta aprobada: pago a ${terms.deferredPaymentDays} días.`
}

export interface ContactPhone {
  kind: 'contact' | 'ai'
  display: string
  href: string
}

/** Teléfonos configurados, el de personas primero. Ninguno configurado: lista vacía. */
export function contactPhones(terms: CommercialTerms): ContactPhone[] {
  const entries: Array<[ContactPhone['kind'], string]> = [
    ['contact', terms.contactPhone],
    ['ai', terms.supportPhoneAi]
  ]
  return entries
    .filter(([, display]) => display)
    .map(([kind, display]) => ({ kind, display, href: `tel:${display.replace(/[^\d+]/g, '')}` }))
}

export function primaryContactPhone(terms: CommercialTerms): ContactPhone | null {
  return contactPhones(terms)[0] ?? null
}

/** «llámanos al …» si hay teléfono; si no, «escríbenos a …». Para completar una frase. */
export function contactAction(terms: CommercialTerms): string {
  const phone = primaryContactPhone(terms)
  return phone ? `llámanos al ${phone.display}` : `escríbenos a ${terms.contactEmail}`
}

/** «Te atiende una persona» solo con el teléfono atendido por personas. */
export function supportPromise(terms: CommercialTerms): string {
  const hours = terms.supportHours ? `, ${terms.supportHours}` : ''
  if (terms.contactPhone) return `Te atiende una persona: ${terms.contactPhone}${hours}.`
  if (terms.supportPhoneAi) return `Llámanos al ${terms.supportPhoneAi}${hours} o escríbenos a ${terms.contactEmail}.`
  return `Escríbenos a ${terms.contactEmail}.`
}

/**
 * Franja de garantías: tres o cuatro elementos, cada uno con un hecho. Un elemento sin
 * nada que afirmar no se publica; nunca hay un quinto que quede huérfano en otra fila.
 */
export function commercialPromises(terms: CommercialTerms, options: { bankTransfer: boolean }): CommercialPromise[] {
  const parcel = parcelPromise(terms)
  const deferred = deferredPaymentPromise(terms)
  return [
    ownDeliveryPromise(terms),
    ...(parcel ? [parcel] : []),
    {
      key: 'support' as const,
      icon: 'i-lucide-phone-call',
      title: 'Atención',
      text: supportPromise(terms),
      to: '/contacto',
      concrete: !!terms.supportHours
    },
    {
      key: 'payment' as const,
      icon: 'i-lucide-receipt-text',
      title: 'Formas de pago',
      text: [options.bankTransfer ? 'Tarjeta, Bizum o transferencia.' : 'Tarjeta o Bizum.', deferred ?? '']
        .filter(Boolean)
        .join(' '),
      to: '/formas-de-pago',
      concrete: !!deferred
    }
  ]
}
