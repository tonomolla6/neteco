import {
  allowedReturnActions,
  type AdminOrderReturn,
  type CustomerOrderReturns,
  type ReturnState
} from '../../shared/order-returns'
export const ACTOR = '10000000-0000-4000-8000-000000000046',
  OTHER = '10000000-0000-4000-8000-000000000047',
  ORDER = '30000000-0000-4000-8000-000000000046',
  NEXT = '30000000-0000-4000-8000-000000000047',
  CASE = '40000000-0000-4000-8000-000000000046',
  REF = 'RMA-1234567890ABCDEF12345678',
  NEXT_REF = 'RMA-1234567890ABCDEF12345679',
  TIME = '2026-10-03T00:00:00Z'
const disabled = {
  refunds: false as const,
  fiscal: false as const,
  carrier: false as const,
  attachments: false as const
}
export function adminContext(state: ReturnState = 'requested', version = 1): AdminOrderReturn {
  const admitted = !['requested', 'rejected'].includes(state),
    received = ['received', 'inspected', 'resolution_ready'].includes(state),
    inspected = ['inspected', 'resolution_ready'].includes(state)
  const actions = allowedReturnActions(state, received, inspected)
  return {
    source: 'cloudflare',
    id: CASE,
    publicRef: REF,
    orderId: ORDER,
    state,
    version,
    orderVersion: version,
    reason: 'Synthetic historical return request',
    publicMessage: 'Solicitud pendiente de revisión documentada.',
    createdAt: TIME,
    updatedAt: TIME,
    eligibility: {
      status: state === 'requested' ? 'review_required' : state === 'rejected' ? 'rejected' : 'admitted_after_review',
      automaticallyEligible: false,
      policyVersion: null
    },
    warehouse: { id: 'main', name: 'Synthetic only warehouse' },
    lines: [
      {
        lineIndex: 0,
        sku: 'OLD-SKU',
        name: 'Historical product',
        purchasedQuantity: 2,
        requestedQuantity: 2,
        authorizedQuantity: admitted ? 2 : 0,
        receivedQuantity: received ? 2 : 0,
        inspectedQuantity: inspected ? 2 : 0,
        claimedQuantity: state === 'rejected' ? 0 : 2,
        unitGrossCents: 1200,
        lineGrossCents: 2400,
        currency: 'EUR'
      }
    ],
    readiness: { ready: true, blockers: [] },
    capabilities: { returnsRead: true, returnsTransitions: actions.length > 0, allowedActions: actions, ...disabled },
    decisionRef: admitted ? 'manual-review-ref' : null,
    resolution: state === 'resolution_ready' ? 'Prepared documented resolution' : null,
    timeline: { items: [], pagination: { page: 1, perPage: 25, total: version, pages: Math.ceil(version / 25) } },
    inventoryEffect: 'none',
    custody: 'non_sellable',
    evaluatedAt: TIME
  }
}
export function customerContext(orderId = ORDER, version = 0): CustomerOrderReturns {
  return {
    source: 'cloudflare',
    orderId,
    version,
    readiness: { ready: true, blockers: [] },
    eligibility: { status: 'review_required', automaticallyEligible: false, policyVersion: null },
    lines: [
      {
        lineIndex: 0,
        sku: 'OLD-SKU',
        name: 'Historical product',
        purchasedQuantity: 2,
        claimedQuantity: 0,
        availableQuantity: 2,
        unitGrossCents: 1200,
        lineGrossCents: 2400,
        currency: 'EUR'
      }
    ],
    returns: [],
    pagination: { page: 1, perPage: 25, total: 0, pages: 0 },
    capabilities: { returnsRead: true, returnRequest: true, guestVerification: false, ...disabled },
    inventoryEffect: 'none',
    custody: 'non_sellable',
    evaluatedAt: TIME
  }
}
export function receipt(action: ReturnState = 'approved', version = 2) {
  return {
    source: 'cloudflare',
    commandId: '50000000-0000-4000-8000-000000000046',
    returnId: CASE,
    publicRef: REF,
    orderId: ORDER,
    action,
    state: action,
    version,
    orderVersion: action === 'requested' ? 1 : version,
    inventoryEffect: 'none',
    custody: 'non_sellable',
    updated: true
  }
}
export const listContext = () => ({
  source: 'cloudflare',
  items: [
    {
      id: CASE,
      publicRef: REF,
      orderId: ORDER,
      state: 'requested',
      version: 1,
      reason: 'Historical request reason',
      customerName: 'Original buyer',
      requestedQuantity: 2,
      receivedQuantity: 0,
      createdAt: TIME,
      updatedAt: TIME
    }
  ],
  pagination: { page: 1, perPage: 25, total: 1, pages: 1 },
  capabilities: { returnsRead: true, ...disabled },
  evaluatedAt: TIME
})
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
