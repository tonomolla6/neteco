import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it } from 'vitest'
import QuotePage from '../../app/pages/cuenta/presupuestos.vue'
import '#app/nuxt-vitest-app-entry'
it('offers link creation after the quote panel confirms an order', async () => {
  const wrapper = await mountSuspended(QuotePage, {
    global: {
      stubs: {
        SalesQuotesPanel: {
          name: 'SalesQuotesPanel',
          template:
            "<button @click=\"$emit('confirmed', {action:'convert',quoteId:'68000000-0000-4000-8000-000000000001',orderId:'68000000-0000-4000-8000-000000000002',version:4})\">Confirmar</button>"
        },
        PayGoldLinkPanel: {
          name: 'PayGoldLinkPanel',
          props: ['receipt'],
          template: '<p>{{receipt?.orderId || "sin pedido"}}</p>'
        }
      }
    }
  })
  expect(wrapper.text()).toContain('sin pedido')
  await wrapper.get('button').trigger('click')
  expect(wrapper.text()).toContain('68000000-0000-4000-8000-000000000002')
})
