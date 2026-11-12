// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import Page from '../../app/pages/formas-de-pago.vue'

/** S2: el pago aplazado de empresa es el motivo para abrir cuenta; se dice con el plazo real. */
const config = { commercial: {} as Record<string, unknown> }
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { appEnv: 'production', bankTransferEnabled: true, commercial: config.commercial }
}))
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
afterEach(() => {
  wrapper?.unmount()
  config.commercial = {}
})

describe('payment methods page', () => {
  it('names the deferred term for company accounts and how to get it, only when configured', async () => {
    config.commercial = { deferredPaymentDays: '30', deferredPaymentConditions: 'Tras aprobar la cuenta de empresa.' }
    wrapper = await mountSuspended(Page)
    const deferred = wrapper.get('[data-deferred-payment]')
    expect(deferred.text()).toContain('Empresas con cuenta aprobada: pago a 30 días.')
    expect(deferred.text()).toContain('Tras aprobar la cuenta de empresa.')
    expect(deferred.get('a[href="/registro"]').text()).toContain('Abrir cuenta de empresa')
  })

  it('says nothing about deferred payment without a configured term', async () => {
    wrapper = await mountSuspended(Page)
    expect(wrapper.find('[data-deferred-payment]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/aplazad|a \d+ días/)
  })
})
