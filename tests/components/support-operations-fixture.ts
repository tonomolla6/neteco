import type {
  SupportAdminTicket,
  SupportCustomerTicket,
  SupportOptions,
  SupportReceipt
} from '../../shared/support-operations'
export const ACTOR = '10000000-0000-4000-8000-000000000049',
  OTHER = '10000000-0000-4000-8000-000000000050',
  ORDER = '30000000-0000-4000-8000-000000000049',
  REF = 'SOP-1234567890ABCDEF12345678',
  NEXT_REF = 'SOP-1234567890ABCDEF12345679',
  TIME = '2026-10-03T12:00:00Z'
export function options(): SupportOptions {
  return {
    source: 'cloudflare',
    categories: ['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other'],
    policy: {
      reference: 'explicit-synthetic-policy',
      version: 1,
      privacyNoticePath: '/privacidad',
      retentionDays: 30,
      responseMinutes: null,
      serviceHoursDescription: null
    },
    attachments: false,
    challengeAvailable: false,
    privacyReviewRequired: false
  }
}
function summary(version = 1, publicRef = REF) {
  return {
    publicRef,
    category: 'order' as const,
    subject: 'Consulta contextual confirmada',
    state: 'open' as const,
    version,
    createdAt: TIME,
    updatedAt: TIME,
    nextActionAt: null,
    slaDueAt: null,
    policy: options().policy,
    retentionUntil: '2026-11-02T12:00:00Z',
    identityStatus: 'verified_customer' as const,
    orderId: ORDER,
    productSlug: null,
    categorySlug: null
  }
}
export function customerContext(version = 1, publicRef = REF): SupportCustomerTicket {
  return {
    source: 'cloudflare',
    ...summary(version, publicRef),
    timeline: [
      {
        id: '50000000-0000-4000-8000-000000000049',
        type: 'created',
        actorType: 'customer',
        body: 'Mensaje público inicial de la consulta',
        visibility: 'public',
        state: 'open',
        createdAt: TIME,
        occurredAt: null
      }
    ],
    attachments: [],
    pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
    context: {
      order: {
        id: ORDER,
        status: 'paid',
        currency: 'EUR',
        totalGrossCents: 1200,
        shippingMethod: 'pickup',
        lines: [
          {
            index: 0,
            sku: 'HISTORICAL-SKU',
            name: 'Producto histórico',
            quantity: 1,
            unitGrossCents: 1200,
            grossCents: 1200
          }
        ]
      },
      payment: { status: 'paid', paidGrossCents: 1200 },
      fulfillment: { status: 'delivered', updatedAt: TIME },
      returns: [],
      fiscal: null,
      redacted: []
    },
    capabilities: {
      reply: true,
      manage: false,
      attachments: false,
      refunds: false,
      fiscal: false,
      inventory: false,
      carrier: false
    }
  }
}
export function adminContext(version = 1, publicRef = REF): SupportAdminTicket {
  const customer = customerContext(version, publicRef)
  return {
    ...customer,
    priority: 'normal',
    ownerId: null,
    requester: { name: 'Contacto de fixture', email: 'private@example.invalid', phone: null },
    declaredOrderReference: 'Referencia declarada',
    staff: [{ id: ACTOR, label: 'Operador autorizado' }],
    capabilities: { ...customer.capabilities, manage: true },
    timeline: [
      ...customer.timeline,
      {
        id: '50000000-0000-4000-8000-000000000050',
        type: 'note',
        actorType: 'admin',
        body: 'PRIVATE_INTERNAL_SENTINEL',
        visibility: 'internal',
        state: 'open',
        createdAt: TIME,
        occurredAt: null
      }
    ]
  }
}
export function listContext(admin = false) {
  return {
    source: 'cloudflare',
    items: [admin ? { ...summary(), priority: 'normal', ownerId: null } : summary()],
    pagination: { page: 1, perPage: 25, total: 1, pages: 1 }
  }
}
export function receipt(version = 2, publicRef = REF): SupportReceipt {
  return {
    source: 'cloudflare',
    commandId: '60000000-0000-4000-8000-000000000049',
    publicRef,
    version,
    state: 'open',
    updated: true,
    emailStatus: 'queued',
    inventoryEffect: 'none',
    economicEffect: 'none'
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
