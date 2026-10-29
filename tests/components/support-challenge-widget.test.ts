import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type DOMWrapper } from '@vue/test-utils'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import SupportChallengeWidget from '../../app/components/SupportChallengeWidget.vue'
import SupportContactPanel from '../../app/components/SupportContactPanel.vue'
import SupportContactSection from '../../app/components/SupportContactSection.vue'
import { options, receipt, deferred } from './support-operations-fixture'
import '#app/nuxt-vitest-app-entry'

const { read, post, sessionMock } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), sessionMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
const configuration = { provider: 'turnstile', siteKey: 'synthetic-public-site-key', action: 'neteco_support' } as const
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
function challengeOptions() {
  return { ...options(), challengeAvailable: true, challenge: configuration }
}
type WidgetOptions = {
  sitekey: string
  action: string
  callback: (token: unknown) => void
  'error-callback': () => void
  'expired-callback': () => void
  'timeout-callback': () => void
  'unsupported-callback': () => void
}
function fakeSdk() {
  const rendered: WidgetOptions[] = [],
    readyCallbacks: Array<() => void> = []
  let holdReady = false
  const sdk = {
    render: vi.fn((_container: HTMLElement, value: WidgetOptions): string | undefined => {
      rendered.push(value)
      return 'synthetic-widget-' + rendered.length
    }),
    ready: vi.fn((callback: () => void) => {
      if (holdReady) readyCallbacks.push(callback)
      else callback()
    }),
    reset: vi.fn(),
    remove: vi.fn()
  }
  return {
    sdk,
    rendered,
    readyCallbacks,
    hold: () => {
      holdReady = true
    }
  }
}
function installSdk(value: unknown) {
  Object.defineProperty(window, 'turnstile', { value, configurable: true, writable: true })
}
let fake: ReturnType<typeof fakeSdk>, originalSdk: PropertyDescriptor | undefined
const mounted: Array<{ unmount: () => void }> = []
const intercepted: Array<{ script: HTMLScriptElement; disconnect: () => void }> = []
function interceptScripts() {
  // Do not attach provider scripts to the test document or make provider calls.
  const appendChild = document.head.appendChild.bind(document.head)
  const scripts = vi.fn<(node: HTMLScriptElement) => void>()
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    if (!(node instanceof HTMLScriptElement)) return appendChild(node)
    scripts(node)
    let connected = true
    Object.defineProperty(node, 'isConnected', { configurable: true, get: () => connected })
    intercepted.push({
      script: node,
      disconnect: () => {
        connected = false
      }
    })
    return node
  })
  return scripts
}
beforeEach(() => {
  originalSdk = Object.getOwnPropertyDescriptor(window, 'turnstile')
  fake = fakeSdk()
  installSdk(fake.sdk)
  read.mockReset()
  post.mockReset()
  sessionMock.mockReset()
  sessionMock.mockReturnValue({ ready: ref(true), loggedIn: ref(false), user: ref(null) })
})
afterEach(async () => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  for (const item of intercepted.splice(0)) {
    item.script.dispatchEvent(new Event('error'))
    item.disconnect()
  }
  await flushPromises()
  vi.restoreAllMocks()
  if (originalSdk) Object.defineProperty(window, 'turnstile', originalSdk)
  else Reflect.deleteProperty(window, 'turnstile')
})
async function widget(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(SupportChallengeWidget, {
    props: { configuration, runtime: 'cloudflare', authorized: true, ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function contact() {
  const token = ref('first-temporary-token'),
    data = ref(challengeOptions()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(SupportContactPanel, {
    props: { snapshot: data.value, actorId: 'anonymous-contact', runtime: 'cloudflare', authorize: () => true, reload },
    slots: {
      challenge: ({ setToken }) =>
        h('div', [
          h(
            'button',
            { type: 'button', 'data-testid': 'fixture-token', onClick: () => setToken(token.value) },
            'Local callback fixture'
          ),
          h(
            'button',
            { type: 'button', 'data-testid': 'fixture-expiry', onClick: () => setToken('') },
            'Local expiry fixture'
          )
        ])
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, token, data, reload }
}
async function prepareContact(wrapper: { get: (selector: string) => DOMWrapper<Element> }) {
  await wrapper.get('[data-testid="support-name"]').setValue('Synthetic contact')
  await wrapper.get('[data-testid="support-email"]').setValue('buyer@example.invalid')
  await wrapper.get('[data-testid="support-subject"]').setValue('Consulta local con desafío')
  await wrapper.get('[data-testid="support-body"]').setValue('Contenido público de consulta sintética, estable.')
  await wrapper.get('[data-testid="support-privacy"]').setValue(true)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

describe('support Turnstile client, no provider traffic', () => {
  it('renders the authoritative key/action explicitly and exposes no token in markup', async () => {
    const append = interceptScripts(),
      wrapper = await widget()
    expect(fake.sdk.render).toHaveBeenCalledTimes(1)
    expect(fake.sdk.render.mock.calls[0]?.[0]).toBe(wrapper.get('[data-testid="support-turnstile-container"]').element)
    expect(fake.rendered[0]).toMatchObject({
      sitekey: configuration.siteKey,
      action: 'neteco_support',
      size: 'flexible',
      language: 'es',
      tabindex: 0,
      'response-field': false,
      retry: 'never',
      'refresh-expired': 'manual',
      'refresh-timeout': 'manual'
    })
    fake.rendered[0]!.callback('temporary-proof-not-markup')
    await flushPromises()
    expect(wrapper.emitted('token')?.at(-1)).toEqual(['temporary-proof-not-markup'])
    expect(wrapper.html()).not.toContain('temporary-proof-not-markup')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.text()).toContain('El servidor debe validarla')
    expect(append).not.toHaveBeenCalled()
  })
  it.each([
    { runtime: 'node' },
    { authorized: false },
    { configuration: { ...configuration, action: 'catalog_upload' } }
  ])('loads nothing outside its confirmed native context %#', async (props) => {
    installSdk(undefined)
    const append = interceptScripts(),
      wrapper = await widget(props)
    expect(append).not.toHaveBeenCalled()
    expect(fake.sdk.render).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-challenge-reset"]').exists()).toBe(false)
  })
  it('never invokes getter-bearing configuration or trusts extra secret fields', async () => {
    const getter = vi.fn(() => configuration.siteKey),
      hostile = { provider: 'turnstile', action: 'neteco_support' }
    Object.defineProperty(hostile, 'siteKey', { get: getter, enumerable: true })
    // Vue Test Utils reads Object.values of initial props while checking refs.
    // Deliver hostile data after mounting, through the actual reactive boundary,
    // so the assertion measures our component rather than that harness traversal.
    const wrapper = await widget({ configuration: null })
    await wrapper.setProps({ configuration: hostile })
    await flushPromises()
    expect(getter).not.toHaveBeenCalled()
    expect(fake.sdk.render).not.toHaveBeenCalled()
    await wrapper.setProps({ configuration: { ...configuration, secret: 'private-never-in-DOM' } })
    expect(wrapper.html()).not.toContain('private-never-in-DOM')
    expect(fake.sdk.render).not.toHaveBeenCalled()
  })
  it('shares one exact official script for simultaneous mounted widgets', async () => {
    installSdk(undefined)
    const append = interceptScripts()
    const first = await widget(),
      second = await widget()
    expect(append).toHaveBeenCalledTimes(1)
    expect(intercepted[0]!.script.src).toBe(SCRIPT)
    expect(intercepted[0]!.script.async).toBe(true)
    expect(fake.sdk.render).not.toHaveBeenCalled()
    installSdk(fake.sdk)
    intercepted[0]!.script.dispatchEvent(new Event('load'))
    await flushPromises()
    expect(fake.sdk.render).toHaveBeenCalledTimes(2)
    expect(first.find('[data-testid="support-challenge-reset"]').exists()).toBe(true)
    expect(second.find('[data-testid="support-challenge-reset"]').exists()).toBe(true)
  })
  it('script failure blocks, with only an explicit manual script retry', async () => {
    installSdk(undefined)
    const append = interceptScripts(),
      wrapper = await widget()
    intercepted[0]!.script.dispatchEvent(new Event('error'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('reintenta manualmente')
    await flushPromises()
    expect(append).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="support-challenge-reset"]').trigger('click')
    await flushPromises()
    expect(append).toHaveBeenCalledTimes(2)
    installSdk(fake.sdk)
    intercepted[1]!.script.dispatchEvent(new Event('load'))
    await flushPromises()
    expect(fake.sdk.render).toHaveBeenCalledTimes(1)
  })
  it('a pending script completion cannot render after unmount', async () => {
    installSdk(undefined)
    interceptScripts()
    const wrapper = await widget()
    wrapper.unmount()
    const prior = wrapper.emitted('token')?.length
    installSdk(fake.sdk)
    intercepted[0]!.script.dispatchEvent(new Event('load'))
    await flushPromises()
    expect(fake.sdk.render).not.toHaveBeenCalled()
    expect(wrapper.emitted('token')).toHaveLength(prior!)
  })
  it('held SDK readiness cannot render when authorization is lost', async () => {
    fake.hold()
    const wrapper = await widget()
    await wrapper.setProps({ authorized: false })
    for (const callback of fake.readyCallbacks) callback()
    await flushPromises()
    expect(fake.sdk.render).not.toHaveBeenCalled()
  })
  it.each(['error-callback', 'expired-callback', 'timeout-callback', 'unsupported-callback'] as const)(
    '%s revokes the token without an automatic reset',
    async (callback) => {
      const wrapper = await widget()
      fake.rendered[0]!.callback('temporary-proof')
      fake.rendered[0]![callback]()
      fake.rendered[0]!.callback('late-success-from-revoked-attempt')
      await flushPromises()
      expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      expect(fake.sdk.reset).not.toHaveBeenCalled()
    }
  )
  it('explicit renewal creates new callbacks and never resurrects the prior attempt', async () => {
    const wrapper = await widget()
    fake.rendered[0]!.callback('original-proof')
    await flushPromises()
    await wrapper.get('[data-testid="support-challenge-reset"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
    expect(fake.sdk.reset).not.toHaveBeenCalled()
    expect(fake.sdk.remove).toHaveBeenCalledExactlyOnceWith('synthetic-widget-1')
    expect(fake.sdk.render).toHaveBeenCalledTimes(2)
    fake.rendered[0]!.callback('late-proof-from-previous-attempt')
    expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
    fake.rendered[1]!.callback('renewed-proof')
    await flushPromises()
    expect(wrapper.emitted('token')?.at(-1)).toEqual(['renewed-proof'])
  })
  it.each(['', 'invalid token', 'x'.repeat(2049)])('rejects malformed SDK token %#', async (token) => {
    const wrapper = await widget()
    fake.rendered[0]!.callback(token)
    await flushPromises()
    expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it('sitekey rotation removes the old widget and ignores its late callbacks', async () => {
    const wrapper = await widget(),
      old = fake.rendered[0]!
    old.callback('old-proof')
    await flushPromises()
    await wrapper.setProps({ configuration: { ...configuration, siteKey: 'rotated-public-key' } })
    await flushPromises()
    expect(fake.sdk.remove).toHaveBeenCalledWith('synthetic-widget-1')
    old.callback('late-old-proof')
    expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
    fake.rendered[1]!.callback('current-proof')
    expect(wrapper.emitted('token')?.at(-1)).toEqual(['current-proof'])
  })
  it('authorization loss and unmount remove widgets and suppress late proof callbacks', async () => {
    const wrapper = await widget(),
      old = fake.rendered[0]!
    await wrapper.setProps({ authorized: false })
    old.callback('late-proof')
    expect(wrapper.emitted('token')?.at(-1)).toEqual([''])
    expect(fake.sdk.remove).toHaveBeenCalledWith('synthetic-widget-1')
    const second = await widget(),
      secondOptions = fake.rendered[1]!
    second.unmount()
    const count = second.emitted('token')?.length
    secondOptions.callback('late-unmounted-proof')
    expect(second.emitted('token')).toHaveLength(count!)
  })
  it('server rendering creates no provider script, SDK widget or response input', async () => {
    installSdk(undefined)
    const append = interceptScripts()
    const html = await renderToString(
      createSSRApp(SupportChallengeWidget, { configuration, runtime: 'cloudflare', authorized: true })
    )
    expect(append).not.toHaveBeenCalled()
    expect(fake.sdk.render).not.toHaveBeenCalled()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<input')
  })
})

describe('support contact renewable challenge, immutable business intent', () => {
  it('requires a proof before review when an authoritative descriptor is present', async () => {
    const { wrapper } = await contact()
    await prepareContact(wrapper)
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Completa o renueva')
    expect(post).not.toHaveBeenCalled()
  })
  it('uncertain POST accepts a new token only on explicit same-business/key recovery', async () => {
    const { wrapper, token } = await contact()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    post.mockRejectedValueOnce(new Error('unconfirmed_response'))
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(1)
    const first = post.mock.calls[0]![1],
      { challengeToken: firstToken, ...firstBusiness } = first.body
    expect(firstToken).toBe('first-temporary-token')
    expect(Object.isFrozen(first.body)).toBe(true)
    await wrapper.get('[data-testid="fixture-expiry"]').trigger('click')
    await wrapper.get('[data-testid="support-contact-recover"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="support-contact-recover"]').exists()).toBe(true)
    token.value = 'fresh-temporary-token'
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    expect(post).toHaveBeenCalledTimes(1)
    post.mockResolvedValueOnce(receipt(1))
    await wrapper.get('[data-testid="support-contact-recover"]').trigger('click')
    await flushPromises()
    const second = post.mock.calls[1]![1],
      { challengeToken: secondToken, ...secondBusiness } = second.body
    expect(secondToken).toBe('fresh-temporary-token')
    expect(secondBusiness).toEqual(firstBusiness)
    expect(second.headers).toEqual(first.headers)
    expect(second.retry).toBe(0)
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
    expect(wrapper.html()).not.toMatch(/first-temporary-token|fresh-temporary-token/)
  })
  it('expiry after review blocks dispatch, retains intent and never automatically retries', async () => {
    const { wrapper } = await contact()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    await wrapper.get('[data-testid="fixture-expiry"]').trigger('click')
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('antes de enviar el mismo intento')
  })
  it('local token age blocks dispatch even without an SDK expiry callback', async () => {
    const { wrapper } = await contact(),
      now = Date.now()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    vi.spyOn(Date, 'now').mockReturnValue(now + 240001)
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(true)
  })
  it('expiry while fresh GET is pending cannot send an old captured token', async () => {
    const { wrapper, reload } = await contact(),
      hold = deferred<unknown>(),
      now = Date.now()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    reload.mockImplementationOnce(() => hold.promise as Promise<ReturnType<typeof challengeOptions>>)
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    vi.spyOn(Date, 'now').mockReturnValue(now + 240001)
    hold.resolve(challengeOptions())
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-contact-recover"]').exists()).toBe(true)
  })
  it('SDK expiry during fresh GET revokes the captured credential before POST', async () => {
    const { wrapper, reload } = await contact(),
      hold = deferred<ReturnType<typeof challengeOptions>>()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    reload.mockImplementationOnce(() => hold.promise)
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await wrapper.get('[data-testid="fixture-expiry"]').trigger('click')
    hold.resolve(challengeOptions())
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-contact-recover"]').exists()).toBe(true)
  })
  it('a server descriptor rotation revokes the old token without modifying pending business', async () => {
    const { wrapper } = await contact()
    await wrapper.get('[data-testid="fixture-token"]').trigger('click')
    await prepareContact(wrapper)
    await wrapper.setProps({
      snapshot: { ...challengeOptions(), challenge: { ...configuration, siteKey: 'rotated-key' } }
    })
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(true)
  })
})

describe('contact section authoritative default widget and external slot', () => {
  it('mounts a real widget only from the confirmed GET descriptor', async () => {
    read.mockResolvedValueOnce(challengeOptions())
    const wrapper = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(wrapper)
    await flushPromises()
    expect(read.mock.calls[0]).toMatchObject(['/api/support/options', { method: 'GET', retry: 0, cache: 'no-store' }])
    expect(wrapper.findComponent(SupportChallengeWidget).exists()).toBe(true)
    expect(fake.rendered[0]?.sitekey).toBe(configuration.siteKey)
    expect(post).not.toHaveBeenCalled()
  })
  it('does not fabricate a widget for missing or unconfirmed options', async () => {
    read.mockResolvedValueOnce(options())
    const first = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(first)
    await flushPromises()
    expect(first.findComponent(SupportChallengeWidget).exists()).toBe(false)
    read.mockResolvedValueOnce({ ...challengeOptions(), challenge: { ...configuration, secret: 'private' } })
    const second = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(second)
    await flushPromises()
    expect(second.find('[data-testid="support-options-error"]').exists()).toBe(true)
    expect(second.findComponent(SupportChallengeWidget).exists()).toBe(false)
    expect(second.html()).not.toContain('private')
  })
  it('keeps the external challenge slot with server configuration and token callback', async () => {
    read.mockResolvedValueOnce(challengeOptions())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare' },
      slots: {
        challenge: ({ configuration: descriptor, setToken }) =>
          h(
            'button',
            {
              type: 'button',
              'data-testid': 'external-challenge',
              onClick: () => setToken('external-local-proof')
            },
            descriptor?.siteKey ?? 'missing'
          )
      }
    })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.get('[data-testid="external-challenge"]').text()).toBe(configuration.siteKey)
    expect(wrapper.findComponent(SupportChallengeWidget).exists()).toBe(false)
    await wrapper.get('[data-testid="external-challenge"]').trigger('click')
    await prepareContact(wrapper)
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(true)
    expect(fake.sdk.render).not.toHaveBeenCalled()
  })
  it('Node runtime neither fetches options nor loads a widget', async () => {
    installSdk(undefined)
    const append = interceptScripts()
    const wrapper = await mountSuspended(SupportContactSection, { props: { runtime: 'node' } })
    mounted.push(wrapper)
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(wrapper.findComponent(SupportChallengeWidget).exists()).toBe(false)
  })
})
