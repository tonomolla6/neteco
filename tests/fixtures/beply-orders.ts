import type { FiscalContract } from '../../shared/fiscal-issuance'

/** Synthetic records derived from FacturaScripts core 37e1341d; never live captures.
 * Sources and contract limits are cited in BEPLY-ORDERS-informe.md. */
export const beplyOrderFixture = {
  idpedido: 71,
  codigo: 'PED2026NE71',
  numero2: '10000000-0000-4000-8000-000000000010',
  codcliente: 'NELMOUXWCW',
  coddivisa: 'EUR',
  total: '12.10',
  editable: true,
  idestado: 1,
  observaciones: 'Synthetic order'
}
export const beplyDeliveryFixture = {
  idalbaran: 81,
  codigo: 'ALB2026NE81',
  editable: false
}
export const beplyInvoiceFixture = {
  idfactura: 91,
  codigo: 'FAC2026NE91',
  idpedido: 71,
  total: '12.10',
  coddivisa: 'EUR'
}
export const beplyOrderSnapshotFixture = {
  orderId: beplyOrderFixture.numero2,
  orderNumber: beplyOrderFixture.numero2,
  version: 1,
  confirmedAt: '2026-11-12T10:00:00Z',
  paymentMethod: 'redsys' as const,
  currency: 'EUR' as const,
  customer: {
    externalKey: beplyOrderFixture.numero2,
    legalName: 'Synthetic Buyer',
    email: 'buyer@example.invalid',
    address: {
      line1: 'Synthetic Street 1',
      postalCode: '46870',
      city: 'Ontinyent',
      region: 'Valencia',
      countryCode: 'ES' as const
    }
  },
  shippingAddress: {
    recipientName: 'Synthetic Buyer',
    line1: 'Synthetic Street 2',
    line2: null,
    postalCode: '46870',
    city: 'Ontinyent',
    region: 'Valencia',
    countryCode: 'ES' as const,
    phone: '600000000'
  },
  lines: [
    {
      lineIndex: 0,
      variantId: 'variant-1',
      sku: 'SKU-1',
      description: 'Synthetic product',
      quantity: 1,
      netCents: 1000,
      taxCents: 210,
      grossCents: 1210,
      taxRateBasisPoints: 2100
    }
  ],
  shippingNetCents: 0,
  shippingTaxCents: 0,
  shippingGrossCents: 0,
  shippingTaxRateBasisPoints: 2100,
  totalNetCents: 1000,
  totalTaxCents: 210,
  totalGrossCents: 1210,
  state: 'confirmed' as const,
  expectedDeliveryAt: null,
  shipments: []
}

export const beplyShippingContactFixture = {
  idcontacto: 656108318,
  codcliente: beplyOrderFixture.codcliente,
  nombre: 'Synthetic Buyer',
  telefono1: '600000000',
  direccion: 'Synthetic Street 2',
  ciudad: 'Ontinyent',
  provincia: 'Valencia',
  codpostal: '46870',
  codpais: 'ESP',
  descripcion: `NETECO ${beplyOrderFixture.numero2}`,
  observaciones: `NETECO key=neteco-order:${beplyOrderFixture.numero2}; hash=${'a'.repeat(64)};`
}
export const beplyFiscalContractFixture = {
  schemaVersion: 1,
  fiscalVersion: 1,
  kind: 'ordinary',
  orderId: beplyOrderSnapshotFixture.orderId,
  orderNumber: beplyOrderSnapshotFixture.orderNumber,
  series: 'NE',
  issuedOn: '2026-11-12T10:00:00Z',
  currency: 'EUR',
  paymentMethod: 'redsys',
  idempotencyKey: `invoice:${beplyOrderSnapshotFixture.orderId}:v1`,
  policyId: '10000000-0000-4000-8000-000000000001',
  policyFingerprint: 'a'.repeat(64),
  provider: 'beply',
  environment: 'sandbox',
  validationOnly: false,
  customer: beplyOrderSnapshotFixture.customer,
  lines: [
    {
      lineIndex: 0,
      sku: 'SKU-1',
      description: 'Synthetic product',
      quantity: 1,
      unitGrossCents: 1210,
      unitNetCents: 1000,
      lineNetCents: 1000,
      discountNetCents: 0,
      netCents: 1000,
      taxCents: 210,
      grossCents: 1210,
      taxRateBasisPoints: 2100
    }
  ],
  shippingNetCents: 0,
  shippingTaxCents: 0,
  shippingGrossCents: 0,
  shippingTaxRateBasisPoints: 2100,
  totalNetCents: 1000,
  totalTaxCents: 210,
  totalGrossCents: 1210
} as FiscalContract
