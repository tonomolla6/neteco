import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import CustomerSatisfactionPanel from '../../app/components/CustomerSatisfactionPanel.vue'
import AdminSatisfactionPanel from '../../app/components/AdminSatisfactionPanel.vue'
import { satisfactionIntentHash } from '../../shared/support-satisfaction'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)
vi.mock('../../app/pages/index.vue', () => ({ default: { render: () => null } }))
const REF = 'SOP-1234567890ABCDEF12345678',
  TIME = '2026-10-09T10:00:00Z'
function state() {
  return {
    source: 'cloudflare',
    target: { kind: 'support', id: REF, version: 3 },
    eligible: true,
    reason: null,
    feedback: null,
    privacy: { noticePath: '/privacidad', retentionUntil: '2026-11-08T10:00:00Z', policyHash: 'a'.repeat(64) },
    evaluatedAt: TIME
  }
}
const mounted: Array<{ unmount(): void }> = []
beforeEach(() => {
  mocks.request.mockReset()
  mocks.request.mockResolvedValue(state())
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function customer(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CustomerSatisfactionPanel, {
    props: { kind: 'support', targetId: REF, scopeKey: 'owner-session-1', enabled: true, pending: false, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function prepare(wrapper: Awaited<ReturnType<typeof customer>>, comment = 'Atención sintética clara') {
  await wrapper.get('input[name="satisfaction-score"][value="5"]').setValue(true)
  await wrapper.get('[data-testid="satisfaction-comment"]').setValue(comment)
  await wrapper.get('[data-testid="satisfaction-privacy"]').setValue(true)
  await wrapper.get('[data-testid="satisfaction-form"]').trigger('submit')
  await vi.waitFor(() => expect(wrapper.find('[data-testid="satisfaction-confirm"]').exists()).toBe(true))
}
function service() {
  let receipt: Record<string, unknown> | null = null
  let saved: Record<string, unknown> = state()
  const handler = async (
    path: string,
    options: {
      method?: string
      headers?: Record<string, string>
      body?: { score: number; comment?: string; expectedSourceVersion: number }
    } = {}
  ) => {
    if (options.method === 'POST') {
      receipt = {
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        target: state().target,
        payloadHash: await satisfactionIntentHash('support', REF, options.body),
        score: options.body!.score,
        submittedAt: TIME,
        inventoryEffect: 'none',
        economicEffect: 'none'
      }
      saved = {
        ...state(),
        eligible: false,
        reason: 'already_submitted',
        feedback: { score: options.body!.score, comment: options.body!.comment ?? null, submittedAt: TIME }
      }
      return receipt
    }
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'applied', receipt }
    return saved
  }
  mocks.request.mockImplementation(handler)
  return {
    handler,
    corruptState(value: Record<string, unknown>) {
      saved = value
    }
  }
}
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
describe('optional own satisfaction and exact manual receipt recovery', () => {
  it('reads current eligibility with no POST and explains optional score semantics and privacy', async () => {
    const wrapper = await customer()
    expect(posts()).toHaveLength(0)
    expect(wrapper.text()).toContain('Participar es opcional')
    expect(wrapper.text()).toContain('1 · Muy insatisfecho')
    expect(wrapper.text()).toContain('5 · Muy satisfecho')
    expect(wrapper.get('a[href="/privacidad"]').exists()).toBe(true)
    expect(mocks.request.mock.calls[0]).toMatchObject([
      '/api/account/satisfaction/support/' + REF,
      { retry: 0, cache: 'no-store' }
    ])
  })
  it('requires explicit score/privacy and does not turn an empty comment into invented data', async () => {
    service()
    const wrapper = await customer()
    await wrapper.get('[data-testid="satisfaction-form"]').trigger('submit')
    expect(posts()).toHaveLength(0)
    await prepare(wrapper, '')
    expect(posts()).toHaveLength(0)
    await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(posts()[0]![1].body).toEqual({
      score: 5,
      privacyAcknowledged: true,
      expectedSourceVersion: 3,
      expectedPolicyHash: 'a'.repeat(64)
    })
    expect(wrapper.find('[data-testid="satisfaction-form"]').exists()).toBe(false)
  })
  it('freezes reviewed input and sends exactly once even with a repeated confirm click', async () => {
    service()
    const wrapper = await customer()
    await prepare(wrapper)
    const confirm = wrapper.get('[data-testid="satisfaction-confirm"]')
    await confirm.trigger('click')
    await confirm.trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![1].headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
    expect(wrapper.get('[data-testid="satisfaction-saved"]').text()).toContain('Atención sintética clara')
  })
  it('lost commit response recovers receipt then matching fresh state without another POST', async () => {
    const backend = service()
    mocks.request.mockImplementation(async (path, options) => {
      const result = await backend.handler(path, options)
      if (options?.method === 'POST') throw new Error('lost after commit')
      return result
    })
    const wrapper = await customer()
    await prepare(wrapper)
    await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="satisfaction-recover"]').attributes('disabled')).toBeUndefined()
    )
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    await wrapper.get('[data-testid="satisfaction-recover"]').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('confirmed')).toHaveLength(1))
    expect(posts()).toHaveLength(1)
    const lookup = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
    expect(lookup[0]).not.toContain('Atención')
    expect(lookup[1].headers['X-Neteco-Command-Payload-Hash']).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each([409, 429, 500, 503])('never resubmits an ambiguous HTTP %i, unknown is not absence', async (status) => {
    mocks.request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') throw { statusCode: status, message: 'PRIVATE_SERVER_SENTINEL' }
      return path.includes('/commands/') ? { source: 'cloudflare', outcome: 'unknown' } : state()
    })
    const wrapper = await customer()
    await prepare(wrapper)
    await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="satisfaction-recover"]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(1)
    expect(wrapper.find('[data-testid="satisfaction-confirm"]').exists()).toBe(false)
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    expect(wrapper.text()).not.toContain('PRIVATE_SERVER_SENTINEL')
  })
  it.each(['read-401', 'read-403', 'send-401', 'send-403', 'recover-401', 'recover-403'])(
    'purges private draft and intention on confirmed access rejection %s even before session props refresh',
    async (boundary) => {
      const [phase, code] = boundary.split('-')
      let rejectRead = false
      mocks.request.mockImplementation(async (path, options) => {
        if (rejectRead || (options?.method === 'POST' && phase === 'send') || path.includes('/commands/'))
          throw { statusCode: Number(code), data: { error: { code: 'unauthenticated' } } }
        if (options?.method === 'POST') throw new Error('lost response')
        return state()
      })
      const wrapper = await customer()
      if (phase === 'read') {
        await wrapper.get('[data-testid="satisfaction-comment"]').setValue('PRIVATE_DRAFT_SENTINEL')
        rejectRead = true
        await wrapper.get('[data-testid="satisfaction-refresh"]').trigger('click')
      } else {
        await prepare(wrapper, 'PRIVATE_DRAFT_SENTINEL')
        await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
        await flushPromises()
        if (phase === 'recover') await wrapper.get('[data-testid="satisfaction-recover"]').trigger('click')
      }
      await flushPromises()
      expect(wrapper.text()).not.toContain('PRIVATE_DRAFT_SENTINEL')
      expect(wrapper.vm.$.setupState.comment).toBe('')
      expect(wrapper.vm.$.setupState.intent).toBeNull()
      expect(wrapper.vm.$.setupState.snapshot).toBeNull()
      expect(wrapper.emitted('confirmed')).toBeUndefined()
    }
  )
  it('releases only canonical first-attempt policy rejection and requires manual fresh policy before new consent', async () => {
    let rejected = false
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') {
        rejected = true
        throw { statusCode: 409, data: { error: { code: 'policy_version_conflict' } } }
      }
      return { ...state(), privacy: { ...state().privacy, policyHash: rejected ? 'b'.repeat(64) : 'a'.repeat(64) } }
    })
    const wrapper = await customer()
    await prepare(wrapper)
    await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
    expect(wrapper.find('[data-testid="satisfaction-recover"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="satisfaction-form"]').exists()).toBe(false)
    expect(mocks.request).toHaveBeenCalledTimes(2)
    await wrapper.get('[data-testid="satisfaction-refresh"]').trigger('click')
    await flushPromises()
    await prepare(wrapper)
    expect(posts()).toHaveLength(1)
    await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
    await flushPromises()
    expect(posts()).toHaveLength(2)
    expect(posts()[1]![1].body.expectedPolicyHash).toBe('b'.repeat(64))
    expect(posts()[1]![1].headers['Idempotency-Key']).not.toBe(posts()[0]![1].headers['Idempotency-Key'])
  })
  it.each(['key', 'hash', 'version', 'score', 'another-feedback', 'read-failure'])(
    'does not declare success on mismatched %s',
    async (fault) => {
      const backend = service()
      let sent = false
      mocks.request.mockImplementation(async (path, options) => {
        if (sent && !options?.method && !path.includes('/commands/')) {
          if (fault === 'read-failure') throw new Error('read unavailable')
          if (fault === 'another-feedback')
            return {
              ...state(),
              eligible: false,
              reason: 'already_submitted',
              feedback: { score: 1, comment: 'Otro valor', submittedAt: TIME }
            }
        }
        const result = await backend.handler(path, options)
        if (options?.method !== 'POST') return result
        sent = true
        const receipt = { ...(result as Record<string, unknown>) }
        if (fault === 'key') receipt.commandId = 'a9000000-0000-4000-8000-000000000011'
        if (fault === 'hash') receipt.payloadHash = '0'.repeat(64)
        if (fault === 'version') receipt.target = { ...state().target, version: 4 }
        if (fault === 'score') receipt.score = 1
        return receipt
      })
      const wrapper = await customer()
      await prepare(wrapper)
      await wrapper.get('[data-testid="satisfaction-confirm"]').trigger('click')
      await vi.waitFor(() =>
        expect(wrapper.get('[data-testid="satisfaction-recover"]').attributes('disabled')).toBeUndefined()
      )
      expect(wrapper.emitted('confirmed')).toBeUndefined()
      expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    }
  )
  it.each(['scope', 'authority', 'target', 'unmount'])(
    'purges private drafts and ignores late reads after %s',
    async (boundary) => {
      let resolve!: (value: unknown) => void
      mocks.request.mockReturnValue(
        new Promise((done) => {
          resolve = done
        })
      )
      const wrapper = await customer()
      if (boundary === 'scope') await wrapper.setProps({ scopeKey: 'new-owner', enabled: false })
      if (boundary === 'authority') await wrapper.setProps({ enabled: false })
      if (boundary === 'target') await wrapper.setProps({ targetId: 'SOP-1234567890ABCDEF12345679', enabled: false })
      if (boundary === 'unmount') wrapper.unmount()
      resolve(state())
      await flushPromises()
      expect(wrapper.find('[data-testid="satisfaction-form"]').exists()).toBe(false)
      expect(posts()).toHaveLength(0)
    }
  )
  it('external pending blocks submission without echo-purging its own reviewed intention', async () => {
    const wrapper = await customer()
    await prepare(wrapper)
    await wrapper.setProps({ pending: true })
    expect(wrapper.get('[data-testid="satisfaction-confirm"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ pending: false })
    expect(wrapper.find('[data-testid="satisfaction-confirm"]').exists()).toBe(true)
    expect(posts()).toHaveLength(0)
  })
  it.each(['source_not_final', 'policy_unavailable', 'retention_expired', 'already_submitted'])(
    'honestly disables submission when server says %s',
    async (reason) => {
      mocks.request.mockResolvedValue({ ...state(), eligible: false, reason, privacy: null })
      const wrapper = await customer()
      expect(wrapper.find('[data-testid="satisfaction-form"]').exists()).toBe(false)
      expect(posts()).toHaveLength(0)
    }
  )
})

function summary(page = 1, comments = false) {
  return {
    source: 'cloudflare',
    items: [
      {
        target: state().target,
        score: 5,
        submittedAt: TIME,
        category: 'product',
        shippingMethod: null,
        comment: comments ? 'Comentario privado sintético' : null
      }
    ],
    total: 21,
    page,
    perPage: 20,
    commentsIncluded: comments,
    stats: { count: 21, average: 5, byScore: [1, 2, 3, 4, 5].map((score) => ({ score, count: score === 5 ? 21 : 0 })) },
    evaluatedAt: TIME
  }
}
async function admin() {
  const wrapper = await mountSuspended(AdminSatisfactionPanel, {
    props: { scopeKey: 'staff-1', enabled: true, pending: false }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
describe('private minimal admin satisfaction segments', () => {
  it('defaults to no comments and reads filters only after explicit submit, preserving them for page two', async () => {
    mocks.request.mockImplementation(async (_path, options) =>
      summary(Number(options.query.page), options.query.comments === 'true')
    )
    const wrapper = await admin()
    expect(wrapper.text()).not.toContain('Comentario privado')
    await wrapper.get('[data-testid="satisfaction-source"]').setValue('support')
    await wrapper.get('[data-testid="satisfaction-score-filter"]').setValue('5')
    await wrapper.get('[data-testid="satisfaction-comments-optin"]').setValue(true)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="satisfaction-admin-filters"]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls[1]![1].query).toMatchObject({ source: 'support', score: '5', comments: 'true' })
    expect(wrapper.text()).toContain('Comentario privado sintético')
    await wrapper.get('[data-testid="satisfaction-admin-next"]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls[2]![1].query).toMatchObject({ page: 2, source: 'support', comments: 'true' })
    expect(posts()).toHaveLength(0)
  })
  it.each(['private-extra', 'page', 'comments', 'unavailable'])(
    'does not display unconfirmed or overbroad summary %s',
    async (fault) => {
      if (fault === 'unavailable') mocks.request.mockRejectedValue(new Error('unavailable'))
      else
        mocks.request.mockResolvedValue({
          ...summary(),
          ...(fault === 'private-extra'
            ? { identityId: 'PRIVATE_ID' }
            : fault === 'page'
              ? { page: 2 }
              : { commentsIncluded: true })
        })
      const wrapper = await admin()
      expect(wrapper.text()).toContain('No se ha confirmado el resumen')
      expect(wrapper.text()).not.toContain('Consulta confirmada sin valoraciones')
      expect(wrapper.text()).not.toContain('PRIVATE_ID')
    }
  )
  it('purges opted-in comments and filters on permission revocation and never auto-reapplies them', async () => {
    mocks.request.mockImplementation(async (_path, options) => summary(1, options.query.comments === 'true'))
    const wrapper = await admin()
    await wrapper.get('[data-testid="satisfaction-comments-optin"]').setValue(true)
    await wrapper.get('[data-testid="satisfaction-admin-filters"]').trigger('submit')
    await flushPromises()
    await wrapper.setProps({ enabled: false })
    expect(wrapper.text()).not.toContain('Comentario privado')
    await wrapper.setProps({ enabled: true, scopeKey: 'new-staff' })
    await flushPromises()
    expect(mocks.request.mock.calls.at(-1)![1].query).toEqual({ page: 1, perPage: 20, comments: 'false' })
  })
})
