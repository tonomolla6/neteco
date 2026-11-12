// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import AccountLayout from '../../app/layouts/cuenta.vue'
import { companyStatusExplanation } from '../../app/composables/useAccount'

const state = vi.hoisted(() => ({ path: '/cuenta/pedidos' }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 'u', name: 'Administración Captura', email: 'compras@example.invalid', company: 'Bar Central S.L.' }),
  session: ref(null),
  ready: ref(true),
  clear: vi.fn()
}))
mockNuxtImport('useRoute', () => () => ({ path: state.path, fullPath: state.path, query: {} }))

const stubs = { AppHeader: true, AppFooter: true, ConsentManager: true, AppBottomBar: true }
const vueFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : []
  })

describe('account shell', () => {
  it('identifies the session in one compact line and leaves the heading to each page', async () => {
    const layout = await mountSuspended(AccountLayout, { slots: { default: '<h1>Pedidos</h1>' }, global: { stubs } })
    const identity = layout.get('[data-account-identity]')
    expect(identity.text()).toContain('Bar Central S.L.')
    expect(identity.text()).toContain('compras@example.invalid')
    expect(identity.classes()).toContain('text-[13px]')
    expect(layout.html()).not.toMatch(/text-2xl|text-\[1\.75rem\]/)
    expect(layout.findAll('h1')).toHaveLength(1)
  })

  it('names the lists "Listas" at /cuenta/listas and keeps orders and lists one tap away on mobile', async () => {
    const layout = await mountSuspended(AccountLayout, { slots: { default: '<h1>Pedidos</h1>' }, global: { stubs } })
    const tabs = layout.get('[data-account-tabs]')
    expect(tabs.classes()).toContain('overflow-x-auto')
    expect(tabs.classes()).toContain('lg:hidden')
    const labels = tabs.findAll('a').map((link) => [link.text(), link.attributes('href')])
    expect(labels.slice(0, 4)).toEqual([
      ['Inicio', '/cuenta'],
      ['Pedidos', '/cuenta/pedidos'],
      ['Listas', '/cuenta/listas'],
      ['Direcciones', '/cuenta/direcciones']
    ])
    expect(tabs.get('a[href="/cuenta/pedidos"]').attributes('aria-current')).toBe('page')
    expect(layout.text()).not.toContain('Listas de compra')
  })
})

describe('lists naming and route', () => {
  it('keeps the old address as a permanent redirect', () => {
    expect(readFileSync('app/pages/cuenta/favoritos.vue', 'utf8')).toContain("redirect: '/cuenta/listas'")
    expect(readFileSync('nuxt.config.ts', 'utf8')).toMatch(
      /'\/cuenta\/favoritos': \{\s*redirect: \{ to: '\/cuenta\/listas', statusCode: 301 \}/
    )
  })

  it('never links to the old address or calls a list a favourite in the shop', () => {
    const offenders = vueFiles('app')
      .filter((file) => !file.endsWith('pages/cuenta/favoritos.vue'))
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return /\/cuenta\/favoritos|Guardado en favoritos|Marca como favorito|Listas de compra/.test(source)
      })
    expect(offenders).toEqual([])
  })
})

describe('company account under review', () => {
  it('says what is being checked and what the customer can do meanwhile, without inventing terms', () => {
    expect(companyStatusExplanation('pending', { bankTransfer: false, deferredDays: null })).toBe(
      'Estamos comprobando los datos de tu empresa. Mientras tanto puedes comprar con tarjeta o Bizum; las condiciones de empresa se activan al aprobarla.'
    )
    expect(companyStatusExplanation('pending', { bankTransfer: true, deferredDays: 30 })).toBe(
      'Estamos comprobando los datos de tu empresa. Mientras tanto puedes comprar con tarjeta, Bizum o transferencia; la tarifa de empresa y el pago a 30 días se activan al aprobarla.'
    )
    expect(companyStatusExplanation('rejected', { bankTransfer: false, deferredDays: null })).toContain('600 861 334')
    expect(companyStatusExplanation('approved', { bankTransfer: false, deferredDays: null })).toBe('')
  })
})
