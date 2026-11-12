// @vitest-environment nuxt
import { afterEach, describe, expect, it } from 'vitest'
import { mountChatWidget } from '../../app/utils/chat-widget'

const config = {
  src: 'https://chat.example/w.js',
  id: 'site-42',
  origin: 'https://chat.example',
  requiresConsent: true
}
const widgets = () => document.querySelectorAll('script[data-chat-widget]')

afterEach(() => {
  widgets().forEach((node) => node.remove())
  document.querySelectorAll('script[data-test-nonce]').forEach((node) => node.remove())
})

describe('external chat widget loader', () => {
  it('does nothing without configuration', () => {
    expect(mountChatWidget(document, null, { marketing: true })).toBe(false)
    expect(widgets()).toHaveLength(0)
  })

  it('waits for consent when the provider uses cookies', () => {
    expect(mountChatWidget(document, config, null)).toBe(false)
    expect(mountChatWidget(document, config, { marketing: false })).toBe(false)
    expect(widgets()).toHaveLength(0)
    expect(mountChatWidget(document, { ...config, requiresConsent: false }, null)).toBe(true)
    expect(widgets()).toHaveLength(1)
  })

  it('injects one async script with the widget id and the page CSP nonce', () => {
    const nonced = document.createElement('script')
    nonced.setAttribute('data-test-nonce', '')
    nonced.setAttribute('nonce', 'abc123')
    document.head.append(nonced)
    expect(mountChatWidget(document, config, { marketing: true })).toBe(true)
    expect(mountChatWidget(document, config, { marketing: true })).toBe(false)
    const [script] = widgets() as unknown as HTMLScriptElement[]
    expect(widgets()).toHaveLength(1)
    expect(script!.src).toBe('https://chat.example/w.js')
    expect(script!.async).toBe(true)
    expect(script!.dataset.widgetId).toBe('site-42')
    expect(script!.nonce || script!.getAttribute('nonce')).toBe('abc123')
  })
})
