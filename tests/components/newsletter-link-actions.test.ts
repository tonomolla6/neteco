import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfirmPage from '../../app/pages/newsletter/confirmar.vue'
import UnsubscribePage from '../../app/pages/newsletter/baja.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, routeMock, seoMock, headMock, navigateMock, runtimeMock, runtimeState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  routeMock:
    vi.fn<() => { params: Record<string, string>; query: Record<string, unknown>; path: string; fullPath: string }>(),
  seoMock: vi.fn(),
  headMock: vi.fn(),
  navigateMock: vi.fn(),
  runtimeMock: vi.fn(),
  runtimeState: { public: { serverRuntime: 'node' } }
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useSeoMeta', () => seoMock)
mockNuxtImport('useHead', () => headMock)
// Preserve Nuxt's router/bootstrap configuration before test-specific setup.
// Mocking its whole config with a public-only object prevents router creation.
vi.mock('#app/nuxt', async (importOriginal) => {
  const original = await importOriginal<typeof import('#app/nuxt')>()
  return { ...original, useRuntimeConfig: () => runtimeMock() ?? original.useRuntimeConfig() }
})
mockNuxtImport('navigateTo', () => navigateMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const OPAQUE_TOKEN = 'synthetic-legacy-newsletter-token-00000001'
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup(props, { attrs, slots }) {
    return () => h('button', { ...attrs, type: 'button', disabled: props.disabled || props.loading }, slots.default?.())
  }
})
const Alert = defineComponent({
  props: { title: String, description: String },
  setup(props) {
    return () => h('div', [h('p', props.title), h('p', props.description)])
  }
})
const PAGES = [
  {
    name: 'confirmación',
    component: ConfirmPage,
    path: '/newsletter/confirmar',
    action: 'confirm',
    endpoint: '/api/newsletter/confirm',
    retry: 'Reintentar confirmación'
  },
  {
    name: 'baja',
    component: UnsubscribePage,
    path: '/newsletter/baja',
    action: 'unsubscribe',
    endpoint: '/api/newsletter/unsubscribe',
    retry: 'Reintentar baja'
  }
] as const
type PageCase = (typeof PAGES)[number]
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined
let originalUrl: string

async function render(page: PageCase, options: { token?: unknown } = {}) {
  const token = Object.hasOwn(options, 'token') ? options.token : OPAQUE_TOKEN
  const query = token === undefined ? {} : { token }
  routeMock.mockReturnValue({ params: {}, query, path: page.path, fullPath: page.path })
  window.history.replaceState({}, '', `${page.path}?token=${OPAQUE_TOKEN}&token=second-synthetic-token#fragment`)
  wrapper = await mountSuspended(page.component, {
    route: false,
    global: { stubs: { UButton: Button, UAlert: Alert, UIcon: true } }
  })
  return wrapper
}

function state(page: Wrapper) {
  return proxyRefs(page.setupState) as Record<string, unknown>
}
function callback(page: Wrapper, action: PageCase['action']) {
  return state(page)[action] as () => Promise<void>
}

beforeEach(() => {
  originalUrl = window.location.pathname + window.location.search + window.location.hash
  fetchMock.mockReset().mockResolvedValue({ ok: true })
  routeMock.mockReset()
  seoMock.mockClear()
  headMock.mockClear()
  navigateMock.mockClear()
  runtimeState.public.serverRuntime = 'node'
  runtimeMock.mockReturnValue(runtimeState)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  window.history.replaceState({}, '', originalUrl)
})

describe.each(PAGES)('newsletter: $name', (pageCase) => {
  it('requires an explicit click, removes tokens from browser history and keeps privacy metadata', async () => {
    const page = await render(pageCase)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe(pageCase.path)
    expect(page.html()).not.toContain(OPAQUE_TOKEN)
    expect(seoMock).toHaveBeenCalledWith(expect.objectContaining({ robots: 'noindex, nofollow' }))
    expect(headMock).toHaveBeenCalledWith({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
    expect(page.get('button').attributes('type')).toBe('button')
    await page.get('button').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(pageCase.endpoint, {
      method: 'POST',
      body: { token: OPAQUE_TOKEN }
    })
    expect(page.get('[role="status"]').text()).toContain('Solicitud procesada')
    expect(page.get('[role="status"]').text()).toContain('Si el enlace era válido')
    expect(page.html()).not.toContain(OPAQUE_TOKEN)
  })

  it.each([32, 256])(
    'accepts opaque legacy tokens of length %i without a Cloudflare-specific regex',
    async (length) => {
      const token = 'x'.repeat(length)
      const page = await render(pageCase, { token })
      await callback(page, pageCase.action)()
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(pageCase.endpoint, { method: 'POST', body: { token } })
      expect(page.get('[role="status"]').text()).toContain('Solicitud procesada')
    }
  )

  it.each([
    undefined,
    null,
    '',
    'x'.repeat(31),
    'x'.repeat(257),
    [OPAQUE_TOKEN],
    [OPAQUE_TOKEN, OPAQUE_TOKEN],
    123,
    { toString: () => OPAQUE_TOKEN }
  ])('rejects missing, repeated, coerced or out-of-bounds tokens without making requests: %#', async (token) => {
    const page = await render(pageCase, { token })
    expect(page.get('[role="alert"]').text()).toContain('El enlace está incompleto o no es válido')
    expect(page.find('button').exists()).toBe(false)
    expect(window.location.search).toBe('')
    await callback(page, pageCase.action)()
    state(page).status = 'ready'
    await callback(page, pageCase.action)()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a concurrent cached callback and blocks replay after completion even if display state changes', async () => {
    let resolve!: (receipt: { ok: true }) => void
    fetchMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const page = await render(pageCase)
    const submit = callback(page, pageCase.action)
    const first = submit()
    await submit()
    await nextTick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(page.get('main').attributes('aria-busy')).toBe('true')
    expect(page.get('button[role="status"]').attributes('disabled')).toBeDefined()
    resolve({ ok: true })
    await first
    await nextTick()
    expect(page.get('main').attributes('aria-busy')).toBe('false')
    expect(page.get('[role="status"]').text()).toContain('Solicitud procesada')
    state(page).status = 'ready'
    await submit()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { statusCode: undefined, message: 'provider@example.invalid synthetic token detail' },
    { statusCode: 500, data: { message: OPAQUE_TOKEN } },
    { response: { status: 503 }, data: { email: 'provider@example.invalid' } },
    { status: 429, data: { message: OPAQUE_TOKEN } }
  ])('offers only manual retry after transport, 5xx or rate-limit failure: %#', async (failure) => {
    fetchMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true })
    const page = await render(pageCase)
    await callback(page, pageCase.action)()
    await nextTick()
    expect(page.get('[role="alert"]').text()).not.toContain(OPAQUE_TOKEN)
    expect(page.text()).not.toContain('provider@example.invalid')
    expect(page.text()).not.toContain('Solicitud procesada')
    expect(page.get('button').text()).toBe(pageCase.retry)
    expect(page.get('button').attributes('disabled')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if ('status' in failure && failure.status === 429) expect(page.text()).toContain('Espera un momento')
    await page.get('button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls).toEqual([
      [pageCase.endpoint, { method: 'POST', body: { token: OPAQUE_TOKEN } }],
      [pageCase.endpoint, { method: 'POST', body: { token: OPAQUE_TOKEN } }]
    ])
    expect(page.get('[role="status"]').text()).toContain('Solicitud procesada')
  })

  it('treats a Node invalid/expired-token rejection as fatal without reflecting details or retrying', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 400, data: { message: OPAQUE_TOKEN } })
    const page = await render(pageCase)
    const submit = callback(page, pageCase.action)
    await submit()
    await nextTick()
    expect(page.get('[role="alert"]').text()).toContain('Usa el enlace del último mensaje')
    expect(page.html()).not.toContain(OPAQUE_TOKEN)
    expect(page.find('button').exists()).toBe(false)
    state(page).status = 'ready'
    await submit()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    null,
    {},
    { ok: false },
    { ok: 'true' },
    { ok: true, email: 'synthetic@example.invalid' },
    [{ ok: true }],
    Object.create({ ok: true })
  ])('requires an exact own literal-success receipt, not a malformed response: %#', async (receipt) => {
    fetchMock.mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ok: true })
    const page = await render(pageCase)
    await callback(page, pageCase.action)()
    await nextTick()
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido confirmar la respuesta')
    expect(page.text()).not.toContain('Solicitud procesada')
    expect(page.get('button').text()).toBe(pageCase.retry)
    await page.get('button').trigger('click')
    await flushPromises()
    expect(page.get('[role="status"]').text()).toContain('Solicitud procesada')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('blocks the action if browser token cleanup fails', async () => {
    const replaceState = window.history.replaceState.bind(window.history)
    vi.spyOn(window.history, 'replaceState')
      .mockImplementationOnce(replaceState)
      .mockImplementationOnce(() => {
        throw new Error('synthetic unavailable history')
      })
    const page = await render(pageCase)
    expect(page.get('[role="alert"]').text()).toContain('No se ha podido preparar este enlace')
    await callback(page, pageCase.action)()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks cached callbacks once the page has been unmounted', async () => {
    const page = await render(pageCase)
    const submit = callback(page, pageCase.action)
    page.unmount()
    wrapper = undefined
    await submit()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('confirmed Cloudflare newsletter preference handoff', () => {
  it('offers only a click-driven private navigation after generic confirmation, without rendering token', async () => {
    runtimeState.public.serverRuntime = 'cloudflare'
    const token = `n1.10000000-0000-4000-8000-000000000050.${'a'.repeat(64)}`
    const page = await render(PAGES[0], { token })
    expect(navigateMock).not.toHaveBeenCalled()
    expect(page.html()).not.toContain('Elegir temas y frecuencia')
    await callback(page, 'confirm')()
    await flushPromises()
    expect(page.text()).toContain('Si el enlace era válido')
    expect(page.html()).not.toContain(token)
    expect(navigateMock).not.toHaveBeenCalled()
    const button = page.findAll('button').find((item) => item.text().includes('Elegir temas'))!
    await button.trigger('click')
    expect(navigateMock).toHaveBeenCalledWith({ path: '/newsletter/preferencias', query: { confirm: token } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not offer the handoff for legacy opaque tokens or unsubscribes', async () => {
    runtimeState.public.serverRuntime = 'cloudflare'
    const page = await render(PAGES[0])
    await callback(page, 'confirm')()
    await flushPromises()
    expect(page.text()).not.toContain('Elegir temas y frecuencia')
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
