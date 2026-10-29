import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminInvitationAcceptance from '../../app/components/AdminInvitationAcceptance.vue'
import InvitationPage from '../../app/pages/cuenta/invitacion.vue'
import accountAuthMiddleware from '../../app/middleware/auth'
import invitationPageSource from '../../app/pages/cuenta/invitacion.vue?raw'
import { adminInvitationIntentHash } from '../../shared/admin-invitations'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  auth: { value: null as unknown },
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'http://localhost:3000' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('navigateTo', () => mocks.navigate)
// Nuxt test-utils strips page metadata. Select the configured guard from the
// actual SFC AST, then execute the real middleware rather than duplicating it.
function configuredGuards() {
  const script = parse(invitationPageSource).descriptor.scriptSetup?.content
  if (!script) throw new Error('Missing invitation page script')
  const tree = ts.createSourceFile('invitacion.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: ts.CallExpression[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'definePageMeta')
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (calls.length !== 1 || !calls[0]!.arguments[0] || !ts.isObjectLiteralExpression(calls[0]!.arguments[0]!))
    throw new Error('Missing static invitation route metadata')
  const object = calls[0]!.arguments[0] as ts.ObjectLiteralExpression
  const property = object.properties.find(
    (value) =>
      ts.isPropertyAssignment(value) &&
      (ts.isIdentifier(value.name) || ts.isStringLiteral(value.name)) &&
      value.name.text === 'middleware'
  )
  if (!property) return []
  if (!ts.isPropertyAssignment(property)) throw new Error('Unsupported route guard')
  if (ts.isStringLiteral(property.initializer)) return [property.initializer.text]
  throw new Error('Unsupported invitation route guard configuration')
}
const ID = 'a1000000-0000-4000-8000-000000000001'
const SID = 'a2000000-0000-4000-8000-000000000002'
const INVITATION = 'a3000000-0000-4000-8000-000000000003'
const TOKEN = 'A'.repeat(43)
const preview = {
  source: 'cloudflare',
  invitationId: INVITATION,
  roleCode: 'warehouse',
  permissions: ['inventory.read', 'inventory.write'],
  expiresAt: '2026-10-10T12:00:00Z'
}
type Options = {
  method?: string
  body?: { token: string }
  headers?: Record<string, string>
  retry?: number
  query?: Record<string, string>
}
let auth: {
  ready: Ref<boolean>
  loggedIn: Ref<boolean>
  user: Ref<Record<string, unknown> | null>
  session: Ref<Record<string, unknown> | null>
  fetch: ReturnType<typeof vi.fn>
}
const mounted: Array<{ unmount(): void }> = []
const accepts = () => mocks.request.mock.calls.filter(([path]) => path === '/api/account/invitations/accept')
async function receipt(options: Options, extra = {}) {
  return {
    source: 'cloudflare',
    commandId: options.headers!['Idempotency-Key'],
    action: 'accept',
    invitationId: INVITATION,
    version: 2,
    payloadHash: await adminInvitationIntentHash('accept', null, options.body),
    recordedAt: '2026-10-09T12:00:00Z',
    roleCode: 'warehouse',
    sessionRevoked: true,
    ...extra
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function render(runtime: unknown = 'cloudflare') {
  const wrapper = await mountSuspended(AdminInvitationAcceptance, { props: { runtime } })
  mounted.push(wrapper)
  return wrapper
}
async function review(wrapper: Awaited<ReturnType<typeof render>>) {
  await wrapper.get('[data-invitation-token]').setValue(TOKEN)
  await wrapper.get('[data-invitation-preview]').trigger('click')
  await vi.waitFor(() => expect(wrapper.find('[data-invitation-role]').exists()).toBe(true))
}
async function accept(wrapper: Awaited<ReturnType<typeof render>>) {
  await review(wrapper)
  await wrapper.get('[data-invitation-confirm]').setValue(true)
  await wrapper.get('[data-invitation-accept]').trigger('click')
  await vi.waitFor(() => expect(accepts()).toHaveLength(1))
  await flushPromises()
}
beforeEach(() => {
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'operator@example.invalid', emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SID, sessionVersion: 1 }),
    fetch: vi.fn(async () => undefined)
  }
  mocks.auth.value = auth
  mocks.navigate.mockReset()
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options = {}) => {
    if (path === '/api/account/invitations/preview') return preview
    if (path === '/api/account/invitations/accept') return receipt(options)
    throw new Error('Unexpected invitation request')
  })
  window.history.replaceState(null, '', '/cuenta/invitacion')
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})
describe('administrative invitation explicit current-account acceptance', () => {
  it('never sends an anonymous fragment capability through the account login redirect', async () => {
    auth.loggedIn.value = false
    const guards = configuredGuards()
    const route = { fullPath: `/cuenta/invitacion#token=${TOKEN}` } as Parameters<typeof accountAuthMiddleware>[0]
    if (guards.includes('auth')) {
      await accountAuthMiddleware(route, route)
      expect(mocks.navigate).toHaveBeenCalledTimes(1)
    }
    expect(mocks.navigate.mock.calls.flat().join('')).not.toContain(TOKEN)
    window.history.replaceState(null, '', route.fullPath)
    const wrapper = await mountSuspended(InvitationPage)
    mounted.push(wrapper)
    expect(window.location.hash).toBe('')
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login?redirect=%2Fcuenta%2Finvitacion"]').exists()).toBe(true)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('reabre el enlace original')
  })
  it('mounts the real account route with the Cloudflare component and no automatic request', async () => {
    const wrapper = await mountSuspended(InvitationPage)
    mounted.push(wrapper)
    expect(wrapper.findComponent(AdminInvitationAcceptance).props('runtime')).toBe('cloudflare')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('never offers a false Node API fallback', async () => {
    const wrapper = await render('node')
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it.each(['loading', 'anonymous', 'email', 'mfa', 'invalidSession'])(
    'requires current verified account and MFA before reading: %s',
    async (kind) => {
      if (kind === 'loading') auth.ready.value = false
      if (kind === 'anonymous') auth.loggedIn.value = false
      if (kind === 'email') auth.user.value!.emailVerified = false
      if (kind === 'mfa') auth.user.value!.mfaVerified = false
      if (kind === 'invalidSession') auth.session.value!.sessionVersion = 0
      const wrapper = await render()
      expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
      expect(mocks.request).not.toHaveBeenCalled()
      if (kind === 'mfa') expect(wrapper.find('a[href="/cuenta/seguridad"]').exists()).toBe(true)
    }
  )
  it('consumes the supported fragment once, immediately removes it, and waits for explicit preview', async () => {
    window.history.replaceState(null, '', `/cuenta/invitacion#token=${TOKEN}`)
    const wrapper = await render()
    expect(window.location.hash).toBe('')
    expect((wrapper.get('[data-invitation-token]').element as HTMLInputElement).value).toBe(TOKEN)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.html()).not.toContain(TOKEN)
    window.history.replaceState(null, '', `/cuenta/invitacion#token=${'B'.repeat(43)}`)
    await flushPromises()
    expect((wrapper.get('[data-invitation-token]').element as HTMLInputElement).value).toBe(TOKEN)
  })
  it('ignores query tokens and rejects malformed manual tokens without any request', async () => {
    window.history.replaceState(null, '', `/cuenta/invitacion?token=${TOKEN}`)
    const wrapper = await render()
    expect((wrapper.get('[data-invitation-token]').element as HTMLInputElement).value).toBe('')
    await wrapper.get('[data-invitation-token]').setValue('bad-token')
    await wrapper.get('[data-invitation-preview]').trigger('click')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('shows strict role, permissions and expiry only from explicit read-only POST preview', async () => {
    const wrapper = await render()
    await review(wrapper)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    const [path, options] = mocks.request.mock.calls[0]!
    expect(path).toBe('/api/account/invitations/preview')
    expect(options).toMatchObject({ method: 'POST', body: { token: TOKEN }, retry: 0 })
    expect(options.headers?.['Idempotency-Key']).toBeUndefined()
    expect(wrapper.get('[data-invitation-role]').text()).toContain('warehouse')
    expect(wrapper.text()).toContain('inventory.read')
    expect(wrapper.find('time').attributes('datetime')).toBe(preview.expiresAt)
    expect(accepts()).toHaveLength(0)
  })
  it('rejects malformed preview instead of presenting a grant', async () => {
    mocks.request.mockResolvedValue({ ...preview, permissions: ['inventory.read'], unexpected: TOKEN })
    const wrapper = await render()
    await wrapper.get('[data-invitation-token]').setValue(TOKEN)
    await wrapper.get('[data-invitation-preview]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-invitation-role]').exists()).toBe(false)
    expect(wrapper.find('[data-invitation-error]').exists()).toBe(true)
    expect(accepts()).toHaveLength(0)
  })
  it('keeps preview single-flight without accepting while its read is pending', async () => {
    const pending = deferred<unknown>()
    mocks.request.mockReturnValue(pending.promise)
    const wrapper = await render()
    await wrapper.get('[data-invitation-token]').setValue(TOKEN)
    const button = wrapper.get('[data-invitation-preview]')
    await button.trigger('click')
    await button.trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(accepts()).toHaveLength(0)
    pending.resolve(preview)
    await flushPromises()
    expect(wrapper.get('[data-invitation-role]').text()).toContain('warehouse')
  })
  it('requires explicit confirmation and sends exactly one acceptance with UUID idempotency', async () => {
    const wrapper = await render()
    await review(wrapper)
    expect((wrapper.get('[data-invitation-accept]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('[data-invitation-confirm]').setValue(true)
    const button = wrapper.get('[data-invitation-accept]')
    await button.trigger('click')
    await button.trigger('click')
    await vi.waitFor(() => expect(accepts()).toHaveLength(1))
    expect(accepts()[0]![1]).toMatchObject({ method: 'POST', body: { token: TOKEN }, retry: 0 })
    expect(accepts()[0]![1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    await vi.waitFor(() => expect(wrapper.text()).toContain('Vuelve a iniciar sesión'))
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(TOKEN)
  })
  it('editing the token invalidates preview and confirmation without another request', async () => {
    const wrapper = await render()
    await review(wrapper)
    await wrapper.get('[data-invitation-confirm]').setValue(true)
    await wrapper.get('[data-invitation-token]').setValue('B'.repeat(43))
    expect(wrapper.find('[data-invitation-role]').exists()).toBe(false)
    expect(accepts()).toHaveLength(0)
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('does not send if authority changes while the acceptance hash is being computed', async () => {
    const wrapper = await render()
    await review(wrapper)
    await wrapper.get('[data-invitation-confirm]').setValue(true)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const pending = deferred<ArrayBuffer>()
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => pending.promise)
    await wrapper.get('[data-invitation-accept]').trigger('click')
    auth.session.value!.sessionVersion = 2
    await flushPromises()
    pending.resolve(await digest('SHA-256', new TextEncoder().encode(TOKEN)))
    await flushPromises()
    expect(accepts()).toHaveLength(0)
    expect(wrapper.html()).not.toContain(TOKEN)
  })
  it.each(['command', 'invitation', 'hash', 'action'])(
    'keeps a mismatched acceptance receipt uncertain: %s',
    async (mismatch) => {
      mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
        if (path.endsWith('/preview')) return preview
        return receipt(options, {
          ...(mismatch === 'command' ? { commandId: SID } : {}),
          ...(mismatch === 'invitation' ? { invitationId: SID } : {}),
          ...(mismatch === 'hash' ? { payloadHash: 'b'.repeat(64) } : {}),
          ...(mismatch === 'action' ? { action: 'create' } : {})
        })
      })
      const wrapper = await render()
      await accept(wrapper)
      expect(wrapper.text()).not.toContain('Vuelve a iniciar sesión')
      expect(wrapper.find('[data-invitation-check]').exists()).toBe(true)
      expect(accepts()).toHaveLength(1)
    }
  )
  it('recovers lost acknowledgement through exact GET only, and unknown never means no effect', async () => {
    let original: unknown
    mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
      if (path.endsWith('/preview')) return preview
      if (path.endsWith('/accept')) {
        original = await receipt(options)
        throw new Error('lost acknowledgement')
      }
      return { source: 'cloudflare', outcome: 'unknown', receipt: null }
    })
    const wrapper = await render()
    await accept(wrapper)
    expect(accepts()).toHaveLength(1)
    await wrapper.get('[data-invitation-check]').trigger('click')
    await flushPromises()
    const lookup = mocks.request.mock.calls.at(-1)!
    expect(lookup[0]).toBe(`/api/account/invitations/commands/${accepts()[0]![1].headers['Idempotency-Key']}`)
    expect(lookup[1]).toMatchObject({
      method: 'GET',
      retry: 0,
      query: { payloadHash: await adminInvitationIntentHash('accept', null, { token: TOKEN }) }
    })
    expect(JSON.stringify(lookup)).not.toContain(TOKEN)
    expect(wrapper.text()).not.toContain('Vuelve a iniciar sesión')
    mocks.request.mockResolvedValue({ source: 'cloudflare', outcome: 'applied', receipt: original })
    await wrapper.get('[data-invitation-check]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Vuelve a iniciar sesión'))
    expect(accepts()).toHaveLength(1)
  })
  it.each(['identity', 'session', 'email', 'mfa'])(
    'purges private state and ignores late preview after %s boundary',
    async (boundary) => {
      const pending = deferred<unknown>()
      mocks.request.mockReturnValue(pending.promise)
      const wrapper = await render()
      await wrapper.get('[data-invitation-token]').setValue(TOKEN)
      await wrapper.get('[data-invitation-preview]').trigger('click')
      if (boundary === 'identity') auth.user.value!.id = SID
      if (boundary === 'session') auth.session.value!.sessionVersion = 2
      if (boundary === 'email') auth.user.value!.emailVerified = false
      if (boundary === 'mfa') auth.user.value!.mfaVerified = false
      await flushPromises()
      pending.resolve(preview)
      await flushPromises()
      expect(wrapper.find('[data-invitation-role]').exists()).toBe(false)
      expect(wrapper.html()).not.toContain(TOKEN)
      expect(accepts()).toHaveLength(0)
      const token = wrapper.find('[data-invitation-token]')
      if (token.exists()) expect((token.element as HTMLInputElement).value).toBe('')
    }
  )
  it('does not lose the accepted confirmation when its own operation revokes the session', async () => {
    const wrapper = await render()
    await accept(wrapper)
    await vi.waitFor(() => expect(wrapper.text()).toContain('Vuelve a iniciar sesión'))
    auth.loggedIn.value = false
    auth.session.value = null
    await flushPromises()
    expect(wrapper.text()).toContain('Vuelve a iniciar sesión')
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    expect(accepts()).toHaveLength(1)
  })
  it('discards a late acceptance response if another identity takes over', async () => {
    const pending = deferred<unknown>()
    let original: unknown
    mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
      if (path.endsWith('/preview')) return preview
      original = await receipt(options)
      return pending.promise
    })
    const wrapper = await render()
    await accept(wrapper)
    auth.user.value!.id = SID
    await flushPromises()
    pending.resolve(original)
    await flushPromises()
    expect(wrapper.text()).not.toContain('Vuelve a iniciar sesión')
    expect(wrapper.find('[data-invitation-check]').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(TOKEN)
  })
  it('accepts a matching acknowledgement after its expected session revocation, without retaining the secret', async () => {
    const response = deferred<unknown>()
    mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
      if (path.endsWith('/preview')) return preview
      const value = await receipt(options)
      auth.loggedIn.value = false
      auth.session.value = null
      await flushPromises()
      response.resolve(value)
      return response.promise
    })
    const wrapper = await render()
    await accept(wrapper)
    await vi.waitFor(() => expect(wrapper.text()).toContain('Vuelve a iniciar sesión'))
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(TOKEN)
  })
  it('keeps only recovery metadata across its own lost response and uses explicit session refresh before GET', async () => {
    let applied: unknown
    mocks.request.mockImplementation(async (path: string, options: Options = {}) => {
      if (path.endsWith('/preview')) return preview
      if (path.endsWith('/accept')) {
        applied = await receipt(options)
        auth.loggedIn.value = false
        auth.session.value = null
        throw { statusCode: 401 }
      }
      return { source: 'cloudflare', outcome: 'applied', receipt: applied }
    })
    const wrapper = await render()
    await accept(wrapper)
    expect(wrapper.html()).not.toContain(TOKEN)
    expect(wrapper.find('[data-invitation-token]').exists()).toBe(false)
    auth.fetch.mockImplementation(async () => {
      auth.loggedIn.value = true
      auth.session.value = { sessionId: INVITATION, sessionVersion: 2 }
    })
    await wrapper.get('[data-invitation-refresh-session]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls.filter(([path]) => path.includes('/commands/'))).toHaveLength(0)
    await wrapper.get('[data-invitation-check]').trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Vuelve a iniciar sesión'))
    expect(accepts()).toHaveLength(1)
  })
})
