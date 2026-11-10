import { useNuxtApp } from '#app'
import { createSSRApp, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConsentManager from '../../app/components/ConsentManager.vue'
import { useConsent } from '../../app/composables/useConsent'
import '#app/nuxt-vitest-app-entry'

const cookieName = 'neteco-consent-v1'
const decision = {
  version: 'v1' as const,
  necessary: true as const,
  analytics: false,
  marketing: false,
  decidedAt: '2026-11-10T09:00:00.000Z'
}

function setDecision(value: typeof decision | null) {
  document.cookie = value
    ? `${cookieName}=${encodeURIComponent(JSON.stringify(value))}; path=/`
    : `${cookieName}=; max-age=0; path=/`
}

afterEach(() => {
  setDecision(null)
  delete useNuxtApp().payload.state['$sneteco-consent']
  delete useNuxtApp().payload.state['$sneteco-consent-initial-visible']
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('hydration with the visitor consent cookie', () => {
  it.each([
    { server: null, client: decision, expectedVisible: false },
    { server: decision, client: null, expectedVisible: true }
  ])(
    'keeps the visitor preference authoritative while hydrating cached HTML',
    async ({ server, client, expectedVisible }) => {
      setDecision(server)
      const html = await renderToString(createSSRApp(ConsentManager))
      const root = document.createElement('div')
      root.innerHTML = html
      document.body.append(root)
      const previousFocus = document.createElement('button')
      document.body.append(previousFocus)
      previousFocus.focus()
      expect(root.textContent?.includes('Tu privacidad, bajo tu control')).toBe(!server)

      setDecision(client)
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const clientApp = createSSRApp(ConsentManager)
      try {
        clientApp.mount(root)
        await nextTick()
        expect(useConsent().preferences.value).toEqual(client)
        expect(root.textContent?.includes('Tu privacidad, bajo tu control')).toBe(expectedVisible)
        if (expectedVisible) {
          await nextTick()
          expect(document.activeElement).toBe(root.querySelector('button'))
        } else {
          expect(document.activeElement).toBe(previousFocus)
        }
        expect([...warnings.mock.calls, ...errors.mock.calls].flat().map(String).join(' ')).not.toMatch(
          /hydration.*mismatch/i
        )
      } finally {
        clientApp.unmount()
      }
    }
  )
})
