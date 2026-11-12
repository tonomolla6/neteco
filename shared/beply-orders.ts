import { z } from 'zod'
import { fiscalInstant, fiscalUuid } from './fiscal-issuance'
import { roundRatio } from '../server/domain/money'

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    )
const cents = z.number().int().min(0).max(1_000_000_000)
export const beplyRemoteId = z
  .union([
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  ])
  .transform(String)
/** Core/Table/clientes.xml: codcliente is varchar(10). The compact alias is
 * correlation only; duplicate reconciliation must verify the FULL external key.
 * Eight base-36 digits retain more than 41 bits within the existing NE prefix. */
export function beplyCustomerCode(externalKey: string): string {
  const uuid = fiscalUuid.parse(externalKey).replaceAll('-', '')
  return `NE${(BigInt(`0x${uuid}`) % 36n ** 8n).toString(36).toUpperCase().padStart(8, '0')}`
}
export const beplyOrderStateSchema = z.enum([
  'confirmed',
  'preparing',
  'shipped',
  'delivered',
  'cancelled',
  'return_requested',
  'returned',
  'exception'
])
export type BeplyOrderState = z.infer<typeof beplyOrderStateSchema>
export const beplyOrderStateLabels: Record<BeplyOrderState, string> = {
  confirmed: 'Confirmado',
  preparing: 'En preparación',
  shipped: 'Enviado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  return_requested: 'Devolución solicitada',
  returned: 'Devolución',
  exception: 'Incidencia'
}
const address = z
  .object({
    line1: text(160),
    line2: text(160).optional(),
    postalCode: z.string().regex(/^\d{5}$/),
    city: text(80),
    region: text(80),
    countryCode: z.literal('ES')
  })
  .strict()
export const beplyOrderSnapshotSchema = z
  .object({
    orderId: fiscalUuid,
    orderNumber: fiscalUuid,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    confirmedAt: fiscalInstant,
    paymentMethod: z.enum(['redsys', 'bank_transfer', 'credit']),
    currency: z.literal('EUR'),
    customer: z
      .object({
        externalKey: fiscalUuid,
        legalName: text(160),
        email: z.string().email().max(254),
        taxId: text(20).optional(),
        phone: text(24).optional(),
        address
      })
      .strict(),
    shippingAddress: address
      .extend({ line2: text(160).nullable(), recipientName: text(120), phone: text(24) })
      .strict(),
    lines: z
      .array(
        z
          .object({
            lineIndex: z.number().int().min(0).max(99),
            variantId: text(160),
            sku: text(160),
            description: text(500),
            quantity: z.number().int().min(1).max(999),
            netCents: cents,
            taxCents: cents,
            grossCents: cents,
            taxRateBasisPoints: z.number().int().min(0).max(10000)
          })
          .strict()
      )
      .min(1)
      .max(100),
    shippingNetCents: cents,
    shippingTaxCents: cents,
    shippingGrossCents: cents,
    shippingTaxRateBasisPoints: z.number().int().min(0).max(10000),
    totalNetCents: cents,
    totalTaxCents: cents,
    totalGrossCents: cents.min(1),
    state: beplyOrderStateSchema,
    expectedDeliveryAt: fiscalInstant.nullable(),
    shipments: z
      .array(
        z
          .object({
            parcelIndex: z.number().int().min(0).max(19),
            carrier: text(100),
            trackingNumber: text(120),
            shipmentNumber: text(120)
          })
          .strict()
      )
      .max(20)
  })
  .strict()
  .superRefine((value, ctx) => {
    const invalid =
      value.orderId !== value.orderNumber ||
      value.lines.some((line) => line.netCents + line.taxCents !== line.grossCents) ||
      value.shippingNetCents + value.shippingTaxCents !== value.shippingGrossCents ||
      value.lines.reduce((sum, line) => sum + line.netCents, value.shippingNetCents) !== value.totalNetCents ||
      value.lines.reduce((sum, line) => sum + line.taxCents, value.shippingTaxCents) !== value.totalTaxCents ||
      value.totalNetCents + value.totalTaxCents !== value.totalGrossCents ||
      new Set(value.lines.map((line) => line.lineIndex)).size !== value.lines.length ||
      new Set(value.lines.map((line) => line.variantId)).size !== value.lines.length ||
      new Set(value.shipments.map((shipment) => shipment.parcelIndex)).size !== value.shipments.length ||
      (value.shipments.length > 0 &&
        !['shipped', 'delivered', 'return_requested', 'returned', 'exception', 'cancelled'].includes(value.state))
    if (invalid) ctx.addIssue({ code: 'custom', message: 'Invalid order snapshot accounting or identity' })
  })
export type BeplyOrderSnapshot = z.infer<typeof beplyOrderSnapshotSchema>
export interface BeplyOrderIdentity {
  key: string
  hash: string
}
export interface BeplyOrderReceipt {
  providerOrderId: string
  code: string
}
export const beplyErpStateSchema = z
  .object({
    served: z.boolean(),
    deliveryNoteIds: z.array(beplyRemoteId).max(100),
    invoiceIds: z.array(beplyRemoteId).max(100)
  })
  .strict()
export type BeplyErpState = z.infer<typeof beplyErpStateSchema>
export interface BeplyOrderAdapter {
  createOrder(snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): Promise<BeplyOrderReceipt>
  lookupOrder(snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): Promise<BeplyOrderReceipt | null>
  updateOrder(providerOrderId: string, snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): Promise<void>
  readOrder(providerOrderId: string, orderNumber: string): Promise<BeplyErpState>
}

/** FacturaScripts 37e1341d: Calculator.php:134-138,246-272,278-342.
 * Classic accumulates unrounded tax by rate; price-adjusted uses rounded gross
 * unit prices minus rounded line net. Prices here are the exact six-decimal
 * prices sent to the API. Captured net/tax allocations are never changed.
 */
export type BeplyTaxMethod = 'classic' | 'price-adjusted'
export function beplyNetUnit(netCents: number, quantity: number): string {
  const scaled = BigInt(roundRatio(BigInt(netCents) * 10000n, BigInt(quantity)))
  return `${scaled / 1000000n}.${String(scaled % 1000000n).padStart(6, '0')}`
}
export function assertBeplyTaxCompatibility(
  snapshot: Pick<BeplyOrderSnapshot, 'shippingNetCents' | 'shippingTaxCents' | 'shippingTaxRateBasisPoints'> & {
    lines: ReadonlyArray<
      Pick<BeplyOrderSnapshot['lines'][number], 'netCents' | 'taxCents' | 'taxRateBasisPoints'> & { quantity?: number }
    >
  },
  method: BeplyTaxMethod = 'classic'
): void {
  const groups = new Map<number, { net: bigint; tax: bigint; expectedNet: bigint; expectedTax: bigint }>()
  for (const line of [
    ...snapshot.lines,
    {
      netCents: snapshot.shippingNetCents,
      taxCents: snapshot.shippingTaxCents,
      taxRateBasisPoints: snapshot.shippingTaxRateBasisPoints,
      quantity: 1
    }
  ]) {
    const rate = BigInt(line.taxRateBasisPoints),
      quantity = BigInt(line.quantity ?? 1)
    const unit = BigInt(roundRatio(BigInt(line.netCents) * 10000n, quantity)),
      net = unit * quantity
    const group = groups.get(line.taxRateBasisPoints) ?? { net: 0n, tax: 0n, expectedNet: 0n, expectedTax: 0n }
    group.net += net
    group.tax +=
      rate === 0n
        ? 0n
        : method === 'classic'
          ? net * rate
          : (BigInt(roundRatio(unit * (10000n + rate), 100000000n)) * quantity - BigInt(roundRatio(net, 10000n))) *
            100000000n
    group.expectedNet += BigInt(line.netCents)
    group.expectedTax += BigInt(line.taxCents)
    groups.set(line.taxRateBasisPoints, group)
  }
  for (const group of groups.values())
    if (
      roundRatio(group.net, 10000n) !== Number(group.expectedNet) ||
      roundRatio(group.tax, 100000000n) !== Number(group.expectedTax)
    )
      throw new Error('tax_rounding_review_required')
}

export function beplySupportObservation(snapshot: BeplyOrderSnapshot, identity: BeplyOrderIdentity): string {
  const lines = snapshot.lines.map(
    (line) => `${line.sku} [variante ${line.variantId}]: ${line.quantity} × ${line.description}`
  )
  const shipments = snapshot.shipments.map(
    (shipment) => `${shipment.carrier}: envío ${shipment.shipmentNumber}; seguimiento ${shipment.trackingNumber}`
  )
  return [
    `[NETECO]`,
    `NETECO key=${identity.key}; hash=${identity.hash};`,
    `Pedido ${snapshot.orderNumber}; versión ${snapshot.version}`,
    `Estado: ${beplyOrderStateLabels[snapshot.state]}`,
    `Fecha prevista: ${snapshot.expectedDeliveryAt ?? 'Pendiente de confirmar'}`,
    ...shipments,
    ...lines,
    '[/NETECO]'
  ].join('\n')
}

export const beplyOrderViewSchema = z
  .object({
    audience: z.enum(['admin', 'customer', 'guest']),
    orderId: fiscalUuid,
    status: z.enum(['not_confirmed', 'pending', 'leased', 'synced', 'manual_review']),
    version: z.number().int().nonnegative(),
    syncedVersion: z.number().int().nonnegative(),
    state: beplyOrderStateSchema.nullable(),
    stateLabel: text(80).nullable(),
    providerOrderId: beplyRemoteId.nullable(),
    providerCode: text(100).nullable(),
    erp: beplyErpStateSchema.nullable(),
    erpCheckedAt: fiscalInstant.nullable(),
    expectedDeliveryAt: fiscalInstant.nullable(),
    shipments: beplyOrderSnapshotSchema.shape.shipments,
    lastErrorCode: z
      .string()
      .regex(/^[a-z_]{1,80}$/)
      .nullable()
  })
  .strict()
  .refine((value) => value.syncedVersion <= value.version)
export type BeplyOrderView = z.infer<typeof beplyOrderViewSchema>

/** Operational facts stay owned by Neteco. ERP served/invoiced are separate. */
export function beplyStateFromFacts(facts: {
  cancelled: boolean
  returnState: string | null
  fulfillment: string | null
  hasShipments: boolean
}): BeplyOrderState {
  if (facts.cancelled) return 'cancelled'
  if (facts.returnState && ['received', 'inspected', 'resolution_ready'].includes(facts.returnState)) return 'returned'
  if (facts.returnState && ['requested', 'approved'].includes(facts.returnState)) return 'return_requested'
  if (facts.fulfillment === 'delivered') return 'delivered'
  if (facts.fulfillment === 'exception') return 'exception'
  if (facts.fulfillment === 'in_transit' || facts.hasShipments) return 'shipped'
  if (facts.fulfillment && ['picking', 'packed', 'ready_for_pickup'].includes(facts.fulfillment)) return 'preparing'
  return 'confirmed'
}
