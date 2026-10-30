import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, getQuery } from 'h3'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdrHazardNotice from '../../app/components/AdrHazardNotice.vue'
import '#app/nuxt-vitest-app-entry'

const classified = {
  variantId: 'v-1',
  classified: true,
  unNumber: 'UN 1993',
  properShippingName: 'LIQUIDO INFLAMABLE, N.E.P.',
  adrClass: '3',
  packingGroup: 'II',
  pictograms: ['GHS02', 'GHS07'],
  signalWord: 'PELIGRO',
  hazardStatements: ['H225 Líquido y vapores muy inflamables'],
  precautionaryStatements: ['P210 Mantener alejado del calor'],
  ufiCode: null,
  sdsVersion: '3.2'
}

const ENDPOINT = '/api/storefront/adr/hazard-info'
let handler: (variantId: string) => Promise<unknown> = async () => classified
registerEndpoint(ENDPOINT, (event) => handler(String(getQuery(event).variantId)))

async function mountWith(next: (variantId: string) => Promise<unknown>, variantId = 'v-1') {
  handler = next
  const wrapper = await mountSuspended(AdrHazardNotice, { props: { variantId } })
  await vi.waitFor(() => expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false))
  return wrapper
}

describe('SHP-029 hazard notice', () => {
  afterEach(() => {
    handler = async () => classified
  })

  it('always shows signal word, classification, pictograms and statements for a classified product', async () => {
    const wrapper = await mountWith(async () => classified)
    const text = wrapper.text()
    expect(text).toContain('PELIGRO')
    expect(text).toContain('UN 1993')
    expect(text).toContain('Clase 3')
    expect(text).toContain('Grupo de embalaje II')
    expect(text).toContain('GHS02')
    expect(text).toContain('H225 Líquido y vapores muy inflamables')
    expect(text).toContain('P210 Mantener alejado del calor')
    expect(wrapper.find('[data-hazard-notice]').attributes('aria-live')).toBeUndefined()
  })

  it('states that the classification is pending instead of implying the product is safe', async () => {
    const wrapper = await mountWith(async () => ({
      variantId: 'v-1',
      classified: false,
      pictograms: [],
      hazardStatements: [],
      precautionaryStatements: []
    }))
    expect(wrapper.text()).toContain('Clasificación de peligro pendiente de verificación')
    expect(wrapper.text()).not.toMatch(/no peligroso|seguro/i)
  })

  it('keeps a warning visible when the data cannot be loaded', async () => {
    const wrapper = await mountWith(async () => {
      throw createError({ statusCode: 500, statusMessage: 'boom' })
    })
    expect(wrapper.find('[role="alert"]').text()).toContain('ficha de datos de seguridad')
  })

  it('shows a busy state while loading', async () => {
    handler = () => new Promise(() => undefined)
    const wrapper = await mountSuspended(AdrHazardNotice, { props: { variantId: 'v-1' } })
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
  })

  it('reloads when the selected variant changes and ignores a stale response', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined
    const calls: string[] = []
    handler = (variantId) => {
      calls.push(variantId)
      return variantId === 'v-1'
        ? new Promise((resolve) => (releaseFirst = resolve))
        : Promise.resolve({ ...classified, variantId: 'v-2', signalWord: 'ATENCIÓN' })
    }
    const wrapper = await mountSuspended(AdrHazardNotice, { props: { variantId: 'v-1' } })
    await wrapper.setProps({ variantId: 'v-2' })
    await vi.waitFor(() => expect(wrapper.text()).toContain('ATENCIÓN'))
    releaseFirst({ ...classified, variantId: 'v-1', signalWord: 'PELIGRO' })
    await flushPromises()
    expect(calls).toEqual(['v-1', 'v-2'])
    expect(wrapper.text()).toContain('ATENCIÓN')
    expect(wrapper.text()).not.toContain('PELIGRO')
  })
})
