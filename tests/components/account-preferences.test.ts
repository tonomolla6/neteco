import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import AccountPreferencesPanel from '../../app/components/AccountPreferencesPanel.vue'
import {
  ACCOUNT_PREFERENCES_POLICY_VERSION as POLICY,
  ACCOUNT_PREFERENCES_CONSENT_TEXT as TEXT
} from '../../shared/account-preferences'
import { deterministicUuid } from '../fixtures/deterministic'
import '#app/nuxt-vitest-app-entry'
// Acceptance matrix: CF-only, real bound current account/email session; strict
// opted-out defaults vs failed reads; explicit separate commercial choices and
// ACK, no newsletter toggles/sends; atomic frozen CAS body/key; no auto replay;
// matching receipt AND fresh version/choices before success; manual recovery,
// exact replay only after unknown lookup; races/double clicks; purge all private
// state after scope/session/email/authorization loss/unmount, including late GET.
const mocks = vi.hoisted(() => ({ request: vi.fn(), session: { value: null as unknown } }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
const actorId = deterministicUuid('preference-ui-actor'),
  sessionId = deterministicUuid('preference-ui-session')
let session: {
  ready: Ref<boolean>
  loggedIn: Ref<boolean>
  user: Ref<Record<string, unknown>>
  session: Ref<Record<string, unknown>>
}
type Opt = {
  method?: string
  body?: {
    expectedVersion: number
    preferences: { product_updates: boolean; replenishment: boolean }
    policyVersion: string
  }
  headers?: Record<string, string>
  retry?: number
}
const initial = {
  source: 'cloudflare',
  version: 0,
  preferences: { product_updates: false, replenishment: false },
  policyVersion: POLICY,
  consentText: TEXT,
  updatedAt: null
}
const snapshot = (version = 0, preferences = initial.preferences) => ({
  ...initial,
  version,
  preferences,
  updatedAt: version ? '2026-10-08T12:00:00Z' : null
})
function receipt(options: Opt, extra = {}) {
  return {
    source: 'cloudflare',
    commandId: options.headers!['Idempotency-Key'],
    expectedVersion: options.body!.expectedVersion,
    version: options.body!.expectedVersion + 1,
    preferences: options.body!.preferences,
    policyVersion: POLICY,
    textHash: 'a'.repeat(64),
    recordedAt: '2026-10-08T12:00:00Z',
    ...extra
  }
}
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  session = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actorId, emailVerified: true, mfaVerified: false }),
    session: ref({ sessionId, sessionVersion: 1 })
  }
  mocks.session.value = session
  let current = snapshot()
  mocks.request.mockReset().mockImplementation(async (_path: string, options: Opt = {}) => {
    if (options.method === 'PUT') {
      current = snapshot(options.body!.expectedVersion + 1, options.body!.preferences)
      return receipt(options)
    }
    return current
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(extra = {}) {
  const w = await mountSuspended(AccountPreferencesPanel, {
    props: { runtime: 'cloudflare', scopeKey: 'current-account', enabled: true, pending: false, ...extra }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
async function choose(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-preferences-product]').setValue(true)
  await w.get('[data-preferences-ack]').setValue(true)
}
const puts = () => mocks.request.mock.calls.filter(([, o]) => o?.method === 'PUT')
it('shows confirmed opted-out defaults and separates newsletter without promising delivery', async () => {
  const w = await render()
  expect(mocks.request).toHaveBeenCalledTimes(1)
  expect(w.get('[data-preferences-product]').element).toHaveProperty('checked', false)
  expect(w.get('[data-preferences-replenishment]').element).toHaveProperty('checked', false)
  expect(w.text()).toContain(TEXT)
  expect(w.get('a[href="/cuenta/newsletter"]').text()).toContain('newsletter')
  expect(w.find('[data-preferences-newsletter]').exists()).toBe(false)
  expect(puts()).toHaveLength(0)
})
it.each([{ runtime: 'node' }, { enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not call Cloudflare from inactive scope %j',
  async (props) => {
    await render(props)
    expect(mocks.request).not.toHaveBeenCalled()
  }
)
it('does not invent mandatory MFA for an account without configured MFA', async () => {
  await render()
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
it.each(['ready', 'email', 'session'] as const)('does not read without current %s account authority', async (kind) => {
  if (kind === 'ready') session.ready.value = false
  if (kind === 'email') session.user.value = { ...session.user.value, emailVerified: false }
  if (kind === 'session') session.session.value = { sessionId, sessionVersion: 0 }
  await render()
  expect(mocks.request).not.toHaveBeenCalled()
})
it.each(['network', 'malformed'] as const)('failed %s read is not opted-out state', async (kind) => {
  mocks.request.mockImplementation(async () => {
    if (kind === 'network') throw new Error('synthetic')
    return { ...initial, version: 0, preferences: { product_updates: true, replenishment: false } }
  })
  const w = await render()
  expect(w.find('[data-preferences-product]').exists()).toBe(false)
  expect(w.find('[data-preferences-retry]').exists()).toBe(true)
  expect(w.find('[data-preferences-confirmed]').exists()).toBe(false)
})
it('requires explicit ACK, freezes exact choices/version/key, and confirms only after fresh GET', async () => {
  const w = await render()
  await w.get('[data-preferences-product]').setValue(true)
  expect(w.get('[data-preferences-submit]').attributes('disabled')).toBeDefined()
  await w.get('[data-preferences-ack]').setValue(true)
  await w.get('form').trigger('submit')
  await flushPromises()
  const options = puts()[0]![1]
  expect(options.body).toEqual({
    expectedVersion: 0,
    policyVersion: POLICY,
    preferences: { product_updates: true, replenishment: false }
  })
  expect(options.headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/)
  expect(options.retry).toBe(0)
  expect(mocks.request).toHaveBeenCalledTimes(3)
  expect(w.find('[data-preferences-confirmed]').exists()).toBe(true)
})
it('double submit cannot dispatch a second command', async () => {
  const w = await render()
  await choose(w)
  let resolve!: (v: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await w.get('form').trigger('submit')
  await w.get('form').trigger('submit')
  expect(puts()).toHaveLength(1)
  resolve(receipt(puts()[0]![1]))
  await flushPromises()
})
it('lost PUT response stays unknown and recovers manually by GET without another PUT', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce(new Error('lost_after_commit'))
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(puts()).toHaveLength(1)
  expect(w.find('[data-preferences-unknown]').exists()).toBe(true)
  expect(w.find('[data-preferences-confirmed]').exists()).toBe(false)
  const options = puts()[0]![1],
    saved = receipt(options)
  mocks.request
    .mockResolvedValueOnce({ source: 'cloudflare', commandId: saved.commandId, outcome: 'applied', receipt: saved })
    .mockResolvedValueOnce(snapshot(1, options.body.preferences))
  await w.get('[data-preferences-check]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls.at(-2)![0]).toBe('/api/account/preferences/commands/' + saved.commandId)
  expect(puts()).toHaveLength(1)
  expect(w.find('[data-preferences-confirmed]').exists()).toBe(true)
})
it('unknown receipt never proves absence and enables only explicit same body/key replay', async () => {
  const w = await render()
  await choose(w)
  mocks.request.mockRejectedValueOnce(new Error('lost'))
  await w.get('form').trigger('submit')
  await flushPromises()
  const original = puts()[0]![1]
  expect(w.find('[data-preferences-replay]').exists()).toBe(false)
  mocks.request
    .mockResolvedValueOnce({
      source: 'cloudflare',
      commandId: original.headers['Idempotency-Key'],
      outcome: 'unknown',
      receipt: null
    })
    .mockResolvedValueOnce(snapshot())
  await w.get('[data-preferences-check]').trigger('click')
  await flushPromises()
  expect(puts()).toHaveLength(1)
  expect(w.text()).toContain('no demuestra')
  await w.get('[data-preferences-replay]').trigger('click')
  await flushPromises()
  expect(puts()).toHaveLength(2)
  expect(puts()[1]![1].body).toEqual(original.body)
  expect(puts()[1]![1].headers).toEqual(original.headers)
})
it.each(['wrong-key', 'wrong-version', 'wrong-choices'] as const)('does not trust a %s PUT receipt', async (kind) => {
  const w = await render()
  await choose(w)
  mocks.request.mockImplementationOnce(async (_p: string, o: Opt) =>
    receipt(
      o,
      kind === 'wrong-key'
        ? { commandId: deterministicUuid('wrong-preference-receipt') }
        : kind === 'wrong-version'
          ? { version: 3 }
          : { preferences: { product_updates: false, replenishment: false } }
    )
  )
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.find('[data-preferences-confirmed]').exists()).toBe(false)
  expect(w.find('[data-preferences-unknown]').exists()).toBe(true)
  expect(mocks.request).toHaveBeenCalledTimes(2)
})
it.each(['behind', 'mismatch', 'failed'] as const)(
  'does not claim success with %s fresh state after ACK',
  async (kind) => {
    const w = await render()
    await choose(w)
    mocks.request.mockImplementationOnce(async (_p: string, o: Opt) => receipt(o))
    if (kind === 'failed') mocks.request.mockRejectedValueOnce(new Error('read_failed'))
    else mocks.request.mockResolvedValueOnce(kind === 'behind' ? snapshot() : snapshot(1))
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.find('[data-preferences-confirmed]').exists()).toBe(false)
    expect(w.find('[data-preferences-unknown]').exists()).toBe(true)
  }
)
it.each(['scope', 'session', 'email', 'pending'] as const)(
  'purges private state and suppresses late responses after %s change',
  async (kind) => {
    const w = await render()
    await choose(w)
    let resolve!: (v: unknown) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    await w.get('form').trigger('submit')
    const original = puts()[0]![1]
    if (kind === 'scope') await w.setProps({ scopeKey: 'different-account' })
    if (kind === 'session') session.session.value = { sessionId, sessionVersion: 2 }
    if (kind === 'email') session.user.value = { ...session.user.value, emailVerified: false }
    if (kind === 'pending') await w.setProps({ pending: true })
    await flushPromises()
    const state = w.vm.$.setupState as Record<string, unknown>
    expect(state.intent).toBeNull()
    expect(state.acknowledged).toBe(false)
    resolve(receipt(original))
    await flushPromises()
    expect(w.find('[data-preferences-confirmed]').exists()).toBe(false)
    expect(puts()).toHaveLength(1)
  }
)
it.each([401, 403])(
  'purges snapshot/draft/intent after server %s authority loss, not merely hidden DOM',
  async (status) => {
    const w = await render()
    await choose(w)
    mocks.request.mockRejectedValueOnce({
      statusCode: status,
      data: { error: { code: status === 401 ? 'unauthenticated' : 'email_unverified' } }
    })
    await w.get('form').trigger('submit')
    await flushPromises()
    const state = w.vm.$.setupState as Record<string, unknown>
    expect(state.snapshot).toBeNull()
    expect(state.intent).toBeNull()
    expect(state.productUpdates).toBe(false)
    expect(state.acknowledged).toBe(false)
    expect(w.find('[data-preferences-product]').exists()).toBe(false)
  }
)
it('unmount purges frozen choices and ignores a late command result', async () => {
  const w = await render()
  await choose(w)
  let resolve!: (v: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await w.get('form').trigger('submit')
  const state = w.vm.$.setupState as Record<string, unknown>,
    original = puts()[0]![1]
  expect(state.intent).not.toBeNull()
  w.unmount()
  expect(state.intent).toBeNull()
  expect(state.snapshot).toBeNull()
  expect(state.productUpdates).toBe(false)
  resolve(receipt(original))
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(2)
})
