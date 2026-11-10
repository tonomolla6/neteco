import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useNuxtApp } from '#app'
import { createSSRApp, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConsentManager from '../../app/components/ConsentManager.vue'
import '#app/nuxt-vitest-app-entry'

type Decision = { version: 'v1'; necessary: true; analytics: boolean; marketing: boolean; decidedAt: string }

const mocks = vi.hoisted(() => ({
  decision: null as Decision | null
}))

mockNuxtImport('useConsent', () => () => ({
  preferences: ref(mocks.decision),
  acceptAll: vi.fn(),
  rejectOptional: vi.fn(),
  save: vi.fn()
}))
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { cookiesUrl: '/cookies' }
}))

const decision: Decision = {
  version: 'v1',
  necessary: true,
  analytics: false,
  marketing: false,
  decidedAt: '2026-11-10T09:00:00.000Z'
}

function app() {
  return createSSRApp(ConsentManager)
}

afterEach(() => {
  delete useNuxtApp().payload.state['$sneteco-consent-initial-visible']
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('hydration of a cached consent banner', () => {
  it.each([
    { description: 'cached banner, visitor already decided', server: null, client: decision, expected: false },
    { description: 'cached decision, visitor has not decided', server: decision, client: null, expected: true },
    { description: 'neither has a decision', server: null, client: null, expected: true },
    { description: 'both have a decision', server: decision, client: decision, expected: false }
  ])('hydrates safely when $description', async ({ server, client, expected }) => {
    mocks.decision = server
    const html = await renderToString(app())
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    expect(root.textContent?.includes('Tu privacidad, bajo tu control')).toBe(!server)

    mocks.decision = client
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const clientApp = app()
    try {
      clientApp.mount(root)
      await nextTick()
      expect(root.textContent?.includes('Tu privacidad, bajo tu control')).toBe(expected)
      expect([...warnings.mock.calls, ...errors.mock.calls].flat().map(String).join(' ')).not.toMatch(
        /hydration.*mismatch/i
      )
    } finally {
      clientApp.unmount()
    }
  })
})
