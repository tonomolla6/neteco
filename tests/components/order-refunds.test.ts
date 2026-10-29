import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderRefundPanel from '../../app/components/refunds/OrderRefundPanel.vue'
import AdminRefundActions from '../../app/components/refunds/AdminRefundActions.vue'
import type { FinancialSnapshot } from '../../app/components/refunds/financial-ui'
import '#app/nuxt-vitest-app-entry'

const { read, post, sessionMock } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), sessionMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
const ACTOR = '10000000-0000-4000-8000-000000000041',
  OTHER = '10000000-0000-4000-8000-000000000042',
  ORDER = '20000000-0000-4000-8000-000000000041',
  REFUND = '30000000-0000-4000-8000-000000000041',
  CREDIT = '40000000-0000-4000-8000-000000000041',
  POLICY = '50000000-0000-4000-8000-000000000041',
  RMA = 'RMA-0123456789ABCDEF01234567',
  HASH = 'a'.repeat(64),
  REASON = 'Reviewed private historical return without implicit financial authority'
const session = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string; emailVerified: boolean; mfaVerified: boolean } | null>({
    id: ACTOR,
    emailVerified: true,
    mfaVerified: true
  })
})
function facts(done = false): FinancialSnapshot {
  return {
    refunds: {
      source: 'cloudflare',
      orderId: ORDER,
      capturedCents: 1000,
      reservedCents: 500,
      confirmedCents: done ? 500 : 0,
      simulatedConfirmedCents: 0,
      currency: 'EUR',
      inventoryEffect: 'none',
      items: [
        {
          source: 'cloudflare',
          id: REFUND,
          orderId: ORDER,
          returnPublicRef: RMA,
          workflow: done ? 'completed' : 'awaiting_confirmation',
          generation: done ? 4 : 1,
          contractFingerprint: HASH,
          amountCents: 500,
          creditId: done ? CREDIT : null,
          currency: 'EUR',
          validationOnly: false,
          financialStatus: done ? 'succeeded' : 'not_submitted',
          correctiveStatus: done ? 'completed' : 'not_due',
          lastErrorCode: null,
          inventoryEffect: 'none',
          custody: 'non_sellable',
          capabilities: { confirm: !done, cancel: !done, reconcile: false, resend: false },
          components: [
            {
              component: 'line',
              lineIndex: 0,
              quantity: 1,
              unitOffset: 0,
              sku: 'HISTORICAL-SKU',
              description: 'Historical private line',
              grossCents: 500,
              netCents: 413,
              taxCents: 87,
              taxRateBasisPoints: 2100
            }
          ]
        }
      ]
    },
    credits: done
      ? [
          {
            source: 'cloudflare',
            id: CREDIT,
            refundId: REFUND,
            orderId: ORDER,
            sourceInvoiceId: POLICY,
            workflow: 'completed',
            generation: 4,
            amountCents: 500,
            currency: 'EUR',
            validationOnly: false,
            code: 'RECT-123',
            fiscalStatus: 'issued',
            pdfAvailable: true,
            lastErrorCode: null,
            capabilities: { reconcile: false, resend: false, editOriginal: false }
          }
        ]
      : []
  }
}
let currentSession: ReturnType<typeof session>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  currentSession = session()
  sessionMock.mockImplementation(() => currentSession)
  read.mockReset()
  post.mockReset()
  const value = facts(true)
  read.mockImplementation(async (endpoint: string) =>
    endpoint.endsWith('/refunds') ? value.refunds : value.credits[0]
  )
  post.mockResolvedValue({
    source: 'cloudflare',
    id: REFUND,
    action: 'confirmed',
    generation: 2,
    contractFingerprint: HASH,
    validationOnly: false,
    inventoryEffect: 'none'
  })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function renderReader(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(OrderRefundPanel, {
    props: { orderId: ORDER, runtime: 'cloudflare', audience: 'admin', ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function renderAdmin(props: Record<string, unknown> = {}) {
  const value = facts(),
    reload = vi.fn(async () => value)
  const wrapper = await mountSuspended(AdminRefundActions, {
    props: {
      orderId: ORDER,
      runtime: 'cloudflare',
      audience: 'admin',
      operatorId: ACTOR,
      snapshot: value.refunds,
      credits: [],
      authorize: () => true,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, reload }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function chooseConfirm(wrapper: Awaited<ReturnType<typeof renderAdmin>>['wrapper']) {
  await wrapper.get('[data-testid="refund-admin-action"]').setValue('confirm')
  await wrapper.get('[data-testid="refund-admin-target"]').setValue(REFUND)
  await wrapper.get('[data-testid="refund-admin-reason"]').setValue(REASON)
  await wrapper.get('[data-testid="refund-admin-evidence"]').setValue('reviewed-proof')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

describe('owned private refund and corrective document reader', () => {
  it('uses exact native admin GETs, strict historical amounts and protected admin PDF without any mutation', async () => {
    const wrapper = await renderReader()
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      `/api/admin/orders/${ORDER}/refunds`,
      `/api/admin/orders/${ORDER}/credits/${CREDIT}`
    ])
    expect(read.mock.calls[0]![1]).toMatchObject({ method: 'GET', retry: 0, cache: 'no-store' })
    expect(wrapper.text()).toContain('Operación de devolución confirmada')
    expect(wrapper.text()).toContain('Factura rectificativa emitida')
    expect(wrapper.text()).toContain('5,00')
    expect(wrapper.get('[data-testid="credit-private-pdf"]').attributes()).toMatchObject({
      href: `/api/admin/orders/${ORDER}/credits/${CREDIT}/pdf`,
      referrerpolicy: 'no-referrer'
    })
    expect(wrapper.html()).not.toMatch(/token=|storage_key|fiscal\//)
    expect(post).not.toHaveBeenCalled()
  })
  it.each(['ready', 'loggedIn', 'emailVerified', 'mfaVerified'])(
    'does not read admin facts without current %s',
    async (flag) => {
      if (flag === 'ready') currentSession.ready.value = false
      if (flag === 'loggedIn') currentSession.loggedIn.value = false
      if (flag === 'emailVerified') currentSession.user.value!.emailVerified = false
      if (flag === 'mfaVerified') currentSession.user.value!.mfaVerified = false
      const wrapper = await renderReader()
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('Historical private line')
    }
  )
  it('customer/guest requires this current owned order, uses existing cookies without creating grants or admin commands', async () => {
    currentSession.loggedIn.value = false
    currentSession.user.value = null
    const wrapper = await renderReader({ audience: 'customer' })
    expect(read).not.toHaveBeenCalled()
    await wrapper.setProps({ orderAccessConfirmed: true })
    await flushPromises()
    expect(read.mock.calls[0]![0]).toBe(`/api/orders/${ORDER}/refunds`)
    expect(wrapper.get('a').attributes('href')).toBe(`/api/orders/${ORDER}/credits/${CREDIT}/pdf`)
    await wrapper.setProps({ orderAccessConfirmed: false })
    await flushPromises()
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Historical private line')
    expect(post).not.toHaveBeenCalled()
  })
  it('clears facts/PDF after malformed credit binding, rather than treating failed reads as no refunds', async () => {
    read.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith('/refunds') ? facts(true).refunds : { ...facts(true).credits[0], orderId: POLICY }
    )
    const wrapper = await renderReader()
    expect(wrapper.find('[data-testid="refunds-read-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="refunds-empty"]').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Historical private line')
  })
  it.each(['pending', 'uncertain', 'synthetic'])(
    'renders %s without promising actual issuance or automatic retry',
    async (kind) => {
      const value = facts(true)
      if (kind === 'pending') value.credits[0]!.fiscalStatus = 'fiscal_pending'
      if (kind === 'uncertain') {
        value.credits[0]!.workflow = 'uncertain'
        value.credits[0]!.pdfAvailable = false
        value.credits[0]!.capabilities.reconcile = true
        value.refunds.items[0]!.correctiveStatus = 'uncertain'
      }
      if (kind === 'synthetic') {
        value.refunds.items[0]!.validationOnly = true
        value.refunds.items[0]!.financialStatus = 'validation_completed'
        value.refunds.confirmedCents = 0
        value.refunds.simulatedConfirmedCents = 500
        value.credits[0]!.validationOnly = true
      }
      read.mockImplementation(async (endpoint: string) =>
        endpoint.endsWith('/refunds') ? value.refunds : value.credits[0]
      )
      const wrapper = await renderReader()
      expect(wrapper.text()).not.toContain('Factura rectificativa emitida')
      expect(wrapper.text()).toContain(
        kind === 'pending'
          ? 'Estado fiscal pendiente'
          : kind === 'uncertain'
            ? 'No reintentes la emisión'
            : 'Validación local sintética'
      )
      if (kind === 'uncertain') expect(wrapper.find('a').exists()).toBe(false)
      expect(post).not.toHaveBeenCalled()
    }
  )
  it('discards old private replies after identity changes while a GET is suspended', async () => {
    const waiting = deferred<unknown>()
    read.mockResolvedValueOnce(waiting.promise)
    const wrapper = await renderReader()
    currentSession.user.value!.id = OTHER
    await flushPromises()
    const old = facts(true).refunds
    old.items[0]!.components[0]!.description = 'OLD ACTOR PRIVATE LINE'
    waiting.resolve(old)
    await flushPromises()
    expect(wrapper.text()).not.toContain('OLD ACTOR PRIVATE LINE')
    expect(post).not.toHaveBeenCalled()
  })
  it('does not make a credit GET from an unowned/malformed refund DTO or unsupported runtime', async () => {
    read.mockResolvedValue({ ...facts(true).refunds, orderId: POLICY })
    const wrapper = await renderReader()
    expect(read).toHaveBeenCalledOnce()
    expect(wrapper.find('a').exists()).toBe(false)
    read.mockClear()
    await wrapper.setProps({ runtime: 'node' })
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('governed administrative financial commands, never bank execution UI', () => {
  it.each(['cancel', 'queue_credit', 'reconcile_refund', 'reconcile_credit'] as const)(
    'sends exact governed %s route/body and no economic-executor request',
    async (action) => {
      const value = facts(action === 'queue_credit' || action === 'reconcile_credit'),
        item = value.refunds.items[0]!
      if (action === 'queue_credit') {
        item.creditId = null
        item.correctiveStatus = 'blocked_policy'
        value.credits = []
      }
      if (action === 'reconcile_refund') {
        item.workflow = 'uncertain'
        item.financialStatus = 'uncertain'
        item.generation = 3
        item.capabilities = { confirm: false, cancel: false, reconcile: true, resend: false }
      }
      if (action === 'reconcile_credit') {
        item.correctiveStatus = 'uncertain'
        value.credits[0]!.workflow = 'uncertain'
        value.credits[0]!.pdfAvailable = false
        value.credits[0]!.capabilities.reconcile = true
      }
      const reload = vi.fn(async () => value),
        { wrapper } = await renderAdmin({ snapshot: value.refunds, credits: value.credits, reload })
      await wrapper.get('[data-testid="refund-admin-action"]').setValue(action)
      await wrapper.get('[data-testid="refund-admin-target"]').setValue(action === 'reconcile_credit' ? CREDIT : REFUND)
      if (action === 'queue_credit') await wrapper.get('[data-testid="refund-admin-policy"]').setValue(POLICY)
      await wrapper.get('[data-testid="refund-admin-reason"]').setValue(REASON)
      await wrapper.get('[data-testid="refund-admin-evidence"]').setValue('reviewed-proof')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      post.mockRejectedValueOnce(new Error('injected offline unknown administrative response'))
      await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
      await flushPromises()
      const expectedPath =
        action === 'reconcile_credit'
          ? `/api/admin/credits/${CREDIT}/reconcile`
          : `/api/admin/refunds/${REFUND}/${action === 'queue_credit' ? 'credit' : action === 'reconcile_refund' ? 'reconcile' : action}`
      expect(post).toHaveBeenCalledOnce()
      expect(post.mock.calls[0]![0]).toBe(expectedPath)
      expect(post.mock.calls[0]![1].body).toEqual({
        idempotencyKey: expect.any(String),
        reason: REASON,
        evidenceRef: 'reviewed-proof',
        ...(action === 'queue_credit'
          ? { policyId: POLICY }
          : { expectedGeneration: action === 'reconcile_credit' ? 4 : item.generation })
      })
      expect(post.mock.calls[0]![1].body).not.toHaveProperty('amountCents')
      expect(wrapper.text()).toContain('Resultado no confirmado')
    }
  )
  it.each([{ audience: 'customer' }, { operatorId: OTHER }, { runtime: 'node' }, { authorize: () => false }])(
    'rejects non-admin/unowned command contexts %# even if DTO capabilities say true',
    async (props) => {
      const { wrapper } = await renderAdmin(props)
      expect(wrapper.find('form').exists()).toBe(false)
      expect(post).not.toHaveBeenCalled()
    }
  )
  it('reviews exact confirm command, fresh GETs before CAS and labels authorization as queued rather than succeeded', async () => {
    const { wrapper, reload } = await renderAdmin()
    await chooseConfirm(wrapper)
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="refund-admin-intent"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('5,00')
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]![0]).toBe(`/api/admin/refunds/${REFUND}/confirm`)
    const options = post.mock.calls[0]![1]
    expect(options).toMatchObject({
      method: 'POST',
      retry: 0,
      body: {
        idempotencyKey: expect.any(String),
        expectedGeneration: 1,
        contractFingerprint: HASH,
        reason: REASON,
        evidenceRef: 'reviewed-proof'
      }
    })
    expect(options).not.toHaveProperty('headers')
    expect(wrapper.text()).toContain('No confirma devolución bancaria ni emisión fiscal')
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('blocks known generation drift before POST and never silently substitutes a new CAS generation', async () => {
    const { wrapper, reload } = await renderAdmin(),
      fresh = facts()
    fresh.refunds.items[0]!.generation = 2
    fresh.refunds.items[0]!.workflow = 'queued'
    fresh.refunds.items[0]!.capabilities.confirm = false
    await chooseConfirm(wrapper)
    reload.mockResolvedValue(fresh)
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('El expediente ha cambiado')
  })
  it('preserves exact body/key on lost response, requires explicit fresh recovery and never retries automatically', async () => {
    const { wrapper, reload } = await renderAdmin()
    await chooseConfirm(wrapper)
    post.mockRejectedValueOnce(new Error('offline response loss'))
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('Resultado no confirmado')
    expect(wrapper.find('[data-testid="refund-admin-discard"]').exists()).toBe(false)
    const body = post.mock.calls[0]![1].body,
      fresh = facts()
    fresh.refunds.items[0]!.generation = 2
    fresh.refunds.items[0]!.workflow = 'queued'
    fresh.refunds.items[0]!.capabilities.confirm = false
    reload.mockResolvedValue(fresh)
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1].body).toBe(body)
    expect(reload).toHaveBeenCalledTimes(3)
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('clears internal evidence/PII and ignores a post reply when actor/access changes during await', async () => {
    const { wrapper } = await renderAdmin(),
      waiting = deferred<unknown>()
    await chooseConfirm(wrapper)
    post.mockReturnValueOnce(waiting.promise)
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    currentSession.user.value!.id = OTHER
    await flushPromises()
    expect(wrapper.text()).not.toContain(REASON)
    expect(wrapper.find('[data-testid="refund-admin-intent"]').exists()).toBe(false)
    waiting.resolve({
      source: 'cloudflare',
      id: REFUND,
      action: 'confirmed',
      generation: 2,
      contractFingerprint: HASH,
      validationOnly: false,
      inventoryEffect: 'none'
    })
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('requires explicit policy/RMA version and forwards historical line integers/optional cents without client pricing', async () => {
    const { wrapper } = await renderAdmin()
    await wrapper.get('[data-testid="refund-admin-action"]').setValue('plan')
    await wrapper.get('[data-testid="refund-admin-policy"]').setValue(POLICY)
    await wrapper.get('[data-testid="refund-admin-rma"]').setValue(RMA)
    await wrapper.get('[data-testid="refund-admin-rma-version"]').setValue('5')
    await wrapper.get('[data-testid="refund-line-index-0"]').setValue('0')
    await wrapper.get('[data-testid="refund-line-quantity-0"]').setValue('1')
    await wrapper.get('[data-testid="refund-line-amount-0"]').setValue('200')
    await wrapper.get('[data-testid="refund-admin-reason"]').setValue(REASON)
    await wrapper.get('[data-testid="refund-admin-evidence"]').setValue('reviewed-proof')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('RMA y versión declarada')
    expect(wrapper.text()).toContain('2,00')
    post.mockRejectedValueOnce(new Error('offline unknown result'))
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(post.mock.calls[0]![0]).toBe('/api/admin/refunds/requests')
    expect(post.mock.calls[0]![1].body).toEqual({
      idempotencyKey: expect.any(String),
      policyId: POLICY,
      returnPublicRef: RMA,
      expectedReturnVersion: 5,
      lines: [{ lineIndex: 0, quantity: 1, amountCents: 200 }],
      reason: REASON,
      evidenceRef: 'reviewed-proof'
    })
    expect(post.mock.calls[0]![1].body).not.toHaveProperty('shippingCents')
  })
  it('keeps prepared intent but sends nothing after a failed fresh private read', async () => {
    const { wrapper, reload } = await renderAdmin()
    await chooseConfirm(wrapper)
    reload.mockRejectedValueOnce(new Error('read unconfirmed'))
    await wrapper.get('[data-testid="refund-admin-send"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('No se ha enviado ningún comando')
    expect(wrapper.find('[data-testid="refund-admin-intent"]').exists()).toBe(true)
  })
})
