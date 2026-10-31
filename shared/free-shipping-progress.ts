import {
  classifyShippingZone,
  decideFreeShipping,
  type FreeShippingRule,
  type ShippingProfile,
  type ShippingZone
} from './free-shipping-policy'

export interface FreeShippingCartLine {
  variantId: string
  quantity: number
  unitGrossCents: number
  unitNetCents?: number
  costUnitNetCents?: number | null
  weightGrams?: number
  profileKind?: 'parcel' | 'pallet' | 'adr'
}

export type FreeShippingProgressStatus = 'not_applicable' | 'in_progress' | 'reached' | 'excluded'

export type FreeShippingContextualReason =
  | 'adr_excluded'
  | 'pallet_excluded'
  | 'zone_excluded'
  | 'margin_floor'
  | 'cost_unknown'
  | 'below_threshold'
  | 'granted'
  | 'empty_cart'
  | 'subsidy_cap'
  | 'no_rule'

export interface FreeShippingProgressEvaluation {
  status: FreeShippingProgressStatus
  eligible: boolean
  canBecomeFree: boolean
  reason: FreeShippingContextualReason
  thresholdGrossCents: number
  subtotalGrossCents: number
  progressPercent: number
  missingCents: number
  badgeText: string
  message: string
  detailedExplanation: string
  effectiveProfile: ShippingProfile
  effectiveZone: ShippingZone
}

export interface EvaluateFreeShippingProgressInput {
  items: FreeShippingCartLine[]
  subtotalGrossCents: number
  thresholdGrossCents?: number
  destinationPostalCode?: string | null
  customerProfile?: 'consumer' | 'company'
  activeRule?: FreeShippingRule | null
  shippingNetCents?: number
  minMarginBasisPoints?: number
  ownDeliveryPrefixes?: readonly string[]
  allowFree?: (shippingNetCents: number) => boolean
}

export function formatEuroAmount(cents: number): string {
  const rounded = cents % 100 === 0
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: rounded ? 0 : 2,
    maximumFractionDigits: 2
  }).format(cents / 100)
}

/** Total chargeable weight drives whether pallet is mandatory (> 20 kg). */
export function calculateBasketWeightGrams(items: FreeShippingCartLine[]): number {
  return items.reduce((sum, item) => sum + (item.weightGrams ?? 0) * Math.max(1, item.quantity), 0)
}

/** Determines whether the basket contains ADR, requires pallet, or remains parcel. */
export function resolveEffectiveShippingProfile(items: FreeShippingCartLine[]): ShippingProfile {
  if (items.some((item) => item.profileKind === 'adr')) {
    return 'adr'
  }
  const totalWeight = calculateBasketWeightGrams(items)
  if (items.some((item) => item.profileKind === 'pallet') || totalWeight > 20_000) {
    return 'pallet'
  }
  return 'parcel'
}

/**
 * Single-sourced calculation of free shipping threshold and contextual progress.
 * Requirement MKT-022: Calculado con elegibilidad/margen/perfil logístico;
 * NUNCA promete gratis si ADR/palé/zona lo excluye.
 */
export function evaluateFreeShippingProgress(input: EvaluateFreeShippingProgressInput): FreeShippingProgressEvaluation {
  const threshold = Math.max(0, input.thresholdGrossCents ?? 15000)
  const subtotal = Math.max(0, input.subtotalGrossCents)
  const postalCode = input.destinationPostalCode?.trim() ?? ''
  const ownDeliveryPrefixes = input.ownDeliveryPrefixes ?? []
  const customerProfile = input.customerProfile ?? 'consumer'

  const effectiveProfile = resolveEffectiveShippingProfile(input.items)
  const effectiveZone = postalCode ? classifyShippingZone(postalCode, ownDeliveryPrefixes) : 'peninsular'

  // 1. Empty cart or non-positive subtotal
  if (!input.items.length || subtotal <= 0) {
    return {
      status: 'not_applicable',
      eligible: false,
      canBecomeFree: true,
      reason: 'empty_cart',
      thresholdGrossCents: threshold,
      subtotalGrossCents: 0,
      progressPercent: 0,
      missingCents: threshold,
      badgeText: threshold > 0 ? `Envío gratis desde ${formatEuroAmount(threshold)}` : '',
      message:
        threshold > 0
          ? `Envío gratis en paquetería estándar peninsular a partir de ${formatEuroAmount(threshold)}.`
          : '',
      detailedExplanation: 'Añade productos estándar a tu cesta para comprobar el progreso hacia el envío gratuito.',
      effectiveProfile,
      effectiveZone
    }
  }

  // 2. Conscious subsidy check: if an active rule explicitly subsidises special profile/zone
  if (input.activeRule && input.activeRule.consciousSubsidy) {
    const totalNet = input.items.reduce(
      (sum, item) => sum + (item.unitNetCents ?? Math.round(item.unitGrossCents / 1.21)) * item.quantity,
      0
    )
    const costUnknown = input.items.some(
      (item) => item.costUnitNetCents === null || item.costUnitNetCents === undefined
    )
    const totalCost = costUnknown
      ? null
      : input.items.reduce((sum, item) => sum + (item.costUnitNetCents ?? 0) * item.quantity, 0)
    const shippingNet = input.shippingNetCents ?? 0

    const decision = decideFreeShipping(input.activeRule, {
      profile: effectiveProfile,
      zone: effectiveZone,
      customerProfile,
      goodsGrossCents: subtotal,
      goodsNetCents: totalNet,
      goodsCostNetCents: totalCost,
      shippingNetCents: shippingNet
    })

    if (decision.free) {
      return {
        status: 'reached',
        eligible: true,
        canBecomeFree: true,
        reason: 'granted',
        thresholdGrossCents: threshold,
        subtotalGrossCents: subtotal,
        progressPercent: 100,
        missingCents: 0,
        badgeText: 'Portes gratuitos bonificados',
        message: '¡Tu pedido cuenta con gastos de envío bonificados bajo acuerdo comercial especial!',
        detailedExplanation: input.activeRule.subsidyReason ?? 'Subsidio comercial documentado y aprobado.',
        effectiveProfile,
        effectiveZone
      }
    }
  }

  // 3. ADR exclusion: regulated hazardous chemicals NEVER receive free shipping in standard peninsular parcel
  if (effectiveProfile === 'adr') {
    return {
      status: 'excluded',
      eligible: false,
      canBecomeFree: false,
      reason: 'adr_excluded',
      thresholdGrossCents: threshold,
      subtotalGrossCents: subtotal,
      progressPercent: 0,
      missingCents: 0,
      badgeText: 'Mercancía peligrosa ADR (no elegible para portes gratis)',
      message:
        'Tu cesta contiene productos con perfil ADR / mercancías peligrosas sujetos a normativa de transporte especial, excluidos de la promoción de envío gratuito.',
      detailedExplanation:
        'Los productos químicos clasificados como ADR requieren transportista especializado homologado y trazabilidad específica, por lo que no son aplicables los umbrales de paquetería estándar.',
      effectiveProfile,
      effectiveZone
    }
  }

  // 4. Pallet exclusion: pallet-only products or total weight > 20 kg
  if (effectiveProfile === 'pallet') {
    const totalWeight = calculateBasketWeightGrams(input.items)
    const byWeight = totalWeight > 20_000
    return {
      status: 'excluded',
      eligible: false,
      canBecomeFree: false,
      reason: 'pallet_excluded',
      thresholdGrossCents: threshold,
      subtotalGrossCents: subtotal,
      progressPercent: 0,
      missingCents: 0,
      badgeText: 'Transporte en palé (no elegible para paquetería gratuita)',
      message: byWeight
        ? 'El peso total del pedido supera los 20 kg y requiere transporte sobre palé, excluido del umbral de paquetería estándar gratuita.'
        : 'Tu cesta incluye productos de gran formato que requieren entrega en palé, excluidos de la promoción de envío gratuito estándar.',
      detailedExplanation:
        'Las expediciones paletizadas conllevan manipulación logística pesada y no aplican al tramo de paquetería estándar gratuita.',
      effectiveProfile,
      effectiveZone
    }
  }

  // 5. Zone exclusion: islands (Baleares 07, Canarias 35/38), enclaves (Ceuta 51, Melilla 52), international
  if (effectiveZone === 'remote' || (postalCode && !isPeninsularPostalCode(postalCode))) {
    return {
      status: 'excluded',
      eligible: false,
      canBecomeFree: false,
      reason: 'zone_excluded',
      thresholdGrossCents: threshold,
      subtotalGrossCents: subtotal,
      progressPercent: 0,
      missingCents: 0,
      badgeText: 'Destino fuera de Península (excluido de portes gratis)',
      message:
        'El código postal de entrega está fuera de la Península (Baleares, Canarias, Ceuta o Melilla) y no está incluido en la promoción de envío gratuito peninsular.',
      detailedExplanation:
        'La promoción de portes gratuitos aplica exclusivamente a destinos de España peninsular bajo servicio estándar.',
      effectiveProfile,
      effectiveZone
    }
  }

  // 6. Margin & cost checks if specified
  if (input.minMarginBasisPoints !== undefined && input.minMarginBasisPoints > 0) {
    const totalNet = input.items.reduce(
      (sum, item) => sum + (item.unitNetCents ?? Math.round(item.unitGrossCents / 1.21)) * item.quantity,
      0
    )
    const costUnknown = input.items.some(
      (item) => item.costUnitNetCents === null || item.costUnitNetCents === undefined
    )
    if (costUnknown) {
      return {
        status: 'excluded',
        eligible: false,
        canBecomeFree: false,
        reason: 'cost_unknown',
        thresholdGrossCents: threshold,
        subtotalGrossCents: subtotal,
        progressPercent: 0,
        missingCents: 0,
        badgeText: 'Validación de margen requerida',
        message: 'No es posible validar la elegibilidad de envío gratuito por datos de coste incompletos en la cesta.',
        detailedExplanation:
          'El cálculo comercial requiere conocer el coste neto para respetar el margen mínimo exigido.',
        effectiveProfile,
        effectiveZone
      }
    }
    const totalCost = input.items.reduce((sum, item) => sum + (item.costUnitNetCents ?? 0) * item.quantity, 0)
    const shippingNet = input.shippingNetCents ?? 600
    const margin = totalNet - totalCost - shippingNet
    if (margin < 0 || BigInt(margin) * 10000n < BigInt(totalNet) * BigInt(input.minMarginBasisPoints)) {
      return {
        status: 'excluded',
        eligible: false,
        canBecomeFree: false,
        reason: 'margin_floor',
        thresholdGrossCents: threshold,
        subtotalGrossCents: subtotal,
        progressPercent: 0,
        missingCents: 0,
        badgeText: 'Condición de margen mínimo no alcanzada',
        message:
          'Por las condiciones y margen comercial de los artículos del carrito, no es posible aplicar portes gratuitos.',
        detailedExplanation:
          'La absorción de los costes de transporte quebraría el umbral de rentabilidad mínimo exigido para este pedido.',
        effectiveProfile,
        effectiveZone
      }
    }
  }

  // 7. Eligible standard parcel: progress calculation
  const missingCents = Math.max(0, threshold - subtotal)
  const rawPercent = threshold > 0 ? (subtotal / threshold) * 100 : 100
  const progressPercent = missingCents > 0 ? Math.min(99, Math.floor(rawPercent)) : 100

  if (missingCents > 0) {
    return {
      status: 'in_progress',
      eligible: true,
      canBecomeFree: true,
      reason: 'below_threshold',
      thresholdGrossCents: threshold,
      subtotalGrossCents: subtotal,
      progressPercent,
      missingCents,
      badgeText: `Faltan ${formatEuroAmount(missingCents)} para portes gratis`,
      message: `Añade ${formatEuroAmount(missingCents)} más a tu cesta para conseguir portes gratis en paquetería estándar peninsular.`,
      detailedExplanation: `Umbral de envío gratuito fijado en ${formatEuroAmount(threshold)} para paquetería estándar peninsular.`,
      effectiveProfile,
      effectiveZone
    }
  }

  return {
    status: 'reached',
    eligible: true,
    canBecomeFree: true,
    reason: 'granted',
    thresholdGrossCents: threshold,
    subtotalGrossCents: subtotal,
    progressPercent: 100,
    missingCents: 0,
    badgeText: '¡Portes gratis conseguidos!',
    message: '¡Has alcanzado el umbral para paquetería estándar peninsular gratuita!',
    detailedExplanation:
      'Tu pedido cumple todos los requisitos de importe, perfil de paquetería y zona peninsular para envío gratuito.',
    effectiveProfile,
    effectiveZone
  }
}

function isPeninsularPostalCode(postalCode: string): boolean {
  if (!/^\d{5}$/.test(postalCode)) return false
  const province = Number(postalCode.slice(0, 2))
  if (province < 1 || province > 52) return false
  // 7 (Baleares), 35 (Las Palmas), 38 (S.C. Tenerife), 51 (Ceuta), 52 (Melilla)
  return !new Set([7, 35, 38, 51, 52]).has(province)
}
