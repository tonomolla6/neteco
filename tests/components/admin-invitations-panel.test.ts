import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/AdminInvitationsPanel.vue'
import {
  adminInvitationCreateInputSchema,
  adminInvitationListSchema,
  adminInvitationReceiptSchema,
  adminInvitationIntentHash,
  adminInvitationTokenHash,
  type AdminInvitationCreateInput,
  type AdminInvitationRevokeInput,
  type AdminInvitationReceipt
} from '../../shared/admin-invitations'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  navigation: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://configured.example.test' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const actor = '10000000-0000-4000-8000-000000000082',
  sid = '20000000-0000-4000-8000-000000000082',
  invitationId = '30000000-0000-4000-8000-000000000082',
  email = 'invited-synthetic@example.test',
  recordedAt = '2026-10-09T19:00:00Z',
  origin = 'https://configured.example.test'
const permission = ref(true)
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actor, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: sid, sessionVersion: 1 })
  }
}
let auth: ReturnType<typeof session>
let snapshot: ReturnType<typeof adminInvitationListSchema.parse>
let receipt: AdminInvitationReceipt | null
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
type Options = {
  method?: string
  body?: AdminInvitationCreateInput | AdminInvitationRevokeInput
  headers?: Record<string, string>
  query?: Record<string, unknown>
}
const empty = () =>
  adminInvitationListSchema.parse({
    source: 'cloudflare',
    page: 1,
    perPage: 25,
    total: 0,
    roles: [
      { code: 'support', permissions: ['support.manage'] },
      { code: 'warehouse', permissions: ['inventory.read'] }
    ],
    items: []
  })
beforeEach(() => {
  auth = session()
  permission.value = true
  snapshot = empty()
  receipt = null
  mocks.session.mockReturnValue(auth)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: origin }
  })
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      state: 'ready',
      identityId: auth.user.value.id,
      sessionId: auth.session.value.sessionId,
      sessionVersion: auth.session.value.sessionVersion,
      permissions: permission.value ? ['administration.manage'] : []
    }))
  })
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST') {
      const action = path.endsWith('/revoke') ? 'revoke' : 'create',
        body = options.body!
      if (action === 'create') {
        const input = adminInvitationCreateInputSchema.parse(body)
        snapshot = {
          ...snapshot,
          total: 1,
          items: [
            {
              id: invitationId,
              recipientEmail: input.recipientEmail,
              roleCode: input.roleCode,
              version: 1,
              status: 'pending',
              createdAt: recordedAt,
              expiresAt: '2026-10-10T19:00:00Z',
              acceptedAt: null,
              revokedAt: null
            }
          ]
        }
      } else {
        snapshot = {
          ...snapshot,
          items: snapshot.items.map((item) =>
            item.id === invitationId
              ? { ...item, version: item.version + 1, status: 'revoked', revokedAt: recordedAt }
              : item
          )
        }
      }
      receipt = adminInvitationReceiptSchema.parse({
        source: 'cloudflare',
        commandId: options.headers!['Idempotency-Key'],
        action,
        invitationId,
        version: snapshot.items[0]!.version,
        payloadHash: await adminInvitationIntentHash(action, action === 'create' ? null : invitationId, body),
        recordedAt,
        roleCode: snapshot.items[0]!.roleCode,
        sessionRevoked: false
      })
      return receipt
    }
    if (path.includes('/commands/'))
      return receipt
        ? { source: 'cloudflare', outcome: 'applied', receipt }
        : { source: 'cloudflare', outcome: 'unknown', receipt: null }
    if (path === `/api/admin/invitations/${invitationId}`)
      return snapshot.items.find((item) => item.id === invitationId)
    return snapshot
  })
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'invitations-current', enabled: true, pending: false, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
async function load(w: Awaited<ReturnType<typeof render>>) {
  await w.get('[data-invitations-load]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-email]').exists()).toBe(true))
}
async function review(w: Awaited<ReturnType<typeof render>>) {
  await load(w)
  await w.get('[data-invitations-email]').setValue(email)
  await w.get('[data-invitations-role]').setValue('support')
  await w.get('[data-invitations-hours]').setValue('24')
  await w.get('[data-invitations-reason]').setValue('Synthetic explicitly reviewed support invitation')
  await new DOMWrapper(w.get('[data-invitations-review]').element.closest('form')!).trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-invitations-confirm]').exists()).toBe(true))
}
async function confirm(w: Awaited<ReturnType<typeof render>>) {
  await review(w)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-confirmed]').exists()).toBe(true))
}
it('requires an explicit current-list read, and offers only server-authorized roles', async () => {
  const w = await render()
  expect(mocks.request).not.toHaveBeenCalled()
  await load(w)
  expect(
    w
      .get('[data-invitations-role]')
      .findAll('option')
      .map((item) => item.attributes('value'))
      .filter(Boolean)
  ).toEqual(['support', 'warehouse'])
  expect(posts()).toHaveLength(0)
  expect(w.text()).not.toContain('Correo enviado')
})
it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not request or review without context %j',
  async (props) => {
    const w = await render(props)
    if (w.find('[data-invitations-load]').exists()) await w.get('[data-invitations-load]').trigger('click')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(w.find('[data-invitations-review]').exists()).toBe(false)
  }
)
it.each(['permission', 'email', 'mfa', 'session'] as const)('requires current bound authority: %s', async (kind) => {
  if (kind === 'permission') permission.value = false
  if (kind === 'email') auth.user.value.emailVerified = false
  if (kind === 'mfa') auth.user.value.mfaVerified = false
  if (kind === 'session')
    mocks.navigation.mockReturnValue({
      status: ref('ready'),
      capabilities: ref({
        state: 'ready',
        identityId: actor,
        sessionId: sid,
        sessionVersion: 2,
        permissions: ['administration.manage']
      })
    })
  const w = await render()
  expect(w.find('[data-invitations-review]').exists()).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
})
it('generates a secret only at deliberate review, sends only its hash, and reveals a link after receipt plus fresh GET', async () => {
  const random = vi.spyOn(crypto, 'getRandomValues'),
    w = await render()
  expect(random).not.toHaveBeenCalled()
  await review(w)
  expect(random).toHaveBeenCalledTimes(1)
  expect(posts()).toHaveLength(0)
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-confirmed]').exists()).toBe(true))
  const link = w.get('[data-invitations-share-link]').attributes('href')!,
    token = new URL(link).hash.slice('#token='.length)
  expect(link).toBe(`${origin}/cuenta/invitacion#token=${token}`)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(posts()).toHaveLength(1)
  expect(posts()[0]![1].body.tokenHash).toBe(await adminInvitationTokenHash(token))
  expect(JSON.stringify(mocks.request.mock.calls)).not.toContain(token)
  expect(w.text()).not.toMatch(/correo enviado/i)
  expect(w.emitted('confirmed')).toHaveLength(1)
})
it('does not show a secret or announce success if the fresh detail omits the receipt target', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    return path === `/api/admin/invitations/${invitationId}` ? null : result
  })
  const w = await render()
  await review(w)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-check]').exists()).toBe(true))
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('recovers a lost committed response with an exact command lookup and fresh GET, without a second POST', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    if (options.method === 'POST') throw Error('synthetic_lost_response')
    return result
  })
  const w = await render()
  await review(w)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-check]').exists()).toBe(true))
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
  await w.get('[data-invitations-check]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-confirmed]').exists()).toBe(true))
  expect(posts()).toHaveLength(1)
  const lookup = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
  expect(lookup[0]).toBe(`/api/admin/invitations/commands/${receipt!.commandId}`)
  expect(lookup[1].query).toEqual({ payloadHash: receipt!.payloadHash })
  expect(w.find('[data-invitations-share-link]').exists()).toBe(true)
})
it('keeps an unknown receipt locked without another mutation or a disclosed secret', async () => {
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST') throw Error('synthetic_unknown')
    return path.includes('/commands/') ? { source: 'cloudflare', outcome: 'unknown', receipt: null } : snapshot
  })
  const w = await render()
  await review(w)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-check]').exists()).toBe(true))
  await w.get('[data-invitations-check]').trigger('click')
  await flushPromises()
  expect(posts()).toHaveLength(1)
  expect(w.find('[data-invitations-confirm]').exists()).toBe(false)
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('rejects a receipt with a foreign key before exposing the secret', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    return options.method === 'POST' ? { ...result, commandId: crypto.randomUUID() } : result
  })
  const w = await render()
  await review(w)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-invitations-check]').exists()).toBe(true))
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('reviews revocation separately and confirms the exact version with a fresh detail', async () => {
  const w = await render()
  await confirm(w)
  await w.get(`[data-invitations-revoke="${invitationId}"]`).trigger('click')
  await w.get('[data-invitations-revoke-reason]').setValue('Synthetic explicitly reviewed revocation')
  await new DOMWrapper(w.get('[data-invitations-review-revoke]').element.closest('form')!).trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-invitations-confirm]').exists()).toBe(true))
  expect(posts()).toHaveLength(1)
  await w.get('[data-invitations-confirm]').trigger('click')
  await vi.waitFor(() => expect(posts()).toHaveLength(2))
  await vi.waitFor(() => expect(w.text()).toContain('Revocación verificada'))
  expect(posts()[1]![0]).toBe(`/api/admin/invitations/${invitationId}/revoke`)
  expect(posts()[1]![1].body).toEqual({ expectedVersion: 1, reason: 'Synthetic explicitly reviewed revocation' })
  expect(w.find('[data-invitations-share-link]').exists()).toBe(false)
})
it.each(['permission', 'unmount', 'server403'] as const)(
  'purges private drafts and memory secrets after %s',
  async (kind) => {
    const w = await render()
    await review(w)
    if (kind === 'permission') {
      permission.value = false
      await flushPromises()
    }
    if (kind === 'unmount') w.unmount()
    if (kind === 'server403') {
      mocks.request.mockRejectedValue({ statusCode: 403 })
      await w.get('[data-invitations-confirm]').trigger('click')
      await vi.waitFor(() => expect((w.vm.$.setupState as Record<string, unknown>).intent).toBe(null))
    }
    const state = w.vm.$.setupState as Record<string, unknown>
    expect(state.intent).toBe(null)
    expect(state.snapshot).toBe(null)
    expect(state.recipientEmail).toBe('')
    expect(state.reason).toBe('')
    expect(state.deliverySecret).toBe(null)
  }
)
it('ignores a late private GET after session ownership changes', async () => {
  let resolve: ((value: unknown) => void) | undefined
  mocks.request.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const w = await render()
  await w.get('[data-invitations-load]').trigger('click')
  auth.session.value.sessionVersion = 2
  await flushPromises()
  resolve!(empty())
  await flushPromises()
  expect((w.vm.$.setupState as Record<string, unknown>).snapshot).toBe(null)
  expect(w.find('[data-invitations-email]').exists()).toBe(false)
})
