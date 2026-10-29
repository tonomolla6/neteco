import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import SupportTicketFacts from '../../app/components/support/SupportTicketFacts.vue'
import { adminContext, customerContext } from './support-operations-fixture'
import '#app/nuxt-vitest-app-entry'

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
describe('confirmed catalogue context in support case', () => {
  it.each([false, true])('shows only current DTO catalogue context, administrative=%s', async (administrative) => {
    const snapshot = {
      ...(administrative ? adminContext() : customerContext()),
      productSlug: 'limpiador-neutro',
      categorySlug: 'higiene',
      orderId: null,
      context: { order: null, payment: null, fulfillment: null, returns: [], fiscal: null, redacted: [] }
    }
    const wrapper = await mountSuspended(SupportTicketFacts, { props: { snapshot, administrative } })
    mounted.push(wrapper)
    expect(wrapper.get('a[href="/producto/limpiador-neutro"]').text()).toContain('limpiador-neutro')
    expect(wrapper.get('a[href="/categoria/higiene"]').text()).toContain('higiene')
    expect(wrapper.text()).toContain('Consulta sin vínculo de propiedad a un pedido')
    await wrapper.setProps({ snapshot: { ...snapshot, productSlug: null, categorySlug: null } })
    expect(wrapper.find('a[href^="/producto/"]').exists()).toBe(false)
    expect(wrapper.find('a[href^="/categoria/"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('limpiador-neutro')
  })
})
