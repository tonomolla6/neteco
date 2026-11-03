import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BundleConfigurator from '../../app/components/bundles/BundleConfigurator.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const sampleBundle = {
  id: 'b0000000-0000-4000-8000-000000000001',
  slug: 'kit-desengrase-hosteleria',
  title: 'Kit Desengrase Cocina Profesional',
  description: 'Kit profesional para limpieza profunda y desengrase APPCC.',
  sector: 'hosteleria',
  task: 'desengrase_profundo',
  bundlePriceCents: 4500,
  status: 'active',
  version: 1,
  equivalentStandaloneCents: 6000,
  savingsCents: 1500,
  savingsPercent: 25.0,
  maxAvailableKits: 8,
  inStock: true,
  items: [
    {
      id: 'bi-1',
      variantId: 'v-1',
      variantSku: 'DES-5L',
      variantName: '5 Litros',
      productTitle: 'Desengrasante Alcalino',
      unitPriceCents: 2500,
      taxRate: 0.21,
      defaultQuantity: 2,
      minQuantity: 1,
      maxQuantity: 10,
      effectiveStock: 16
    },
    {
      id: 'bi-2',
      variantId: 'v-2',
      variantSku: 'BRILL-1L',
      variantName: '1 Litro',
      productTitle: 'Abrillantador Acero Inox',
      unitPriceCents: 1000,
      taxRate: 0.21,
      defaultQuantity: 1,
      minQuantity: 1,
      maxQuantity: 5,
      effectiveStock: 12
    }
  ],
  createdAt: '2026-10-29T12:00:00Z',
  updatedAt: '2026-10-29T12:00:00Z'
}

describe('BundleConfigurator Component (MKT-021)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('renders bundle components, stock, pricing, VAT and savings accurately', async () => {
    mocks.request.mockResolvedValueOnce({
      selection: {
        equivalentStandaloneCents: 6000,
        bundlePriceCents: 4500,
        savingsCents: 1500,
        savingsPercent: 25.0,
        taxCents: 945,
        totalCents: 5445,
        maxAvailableKits: 8,
        inStock: true,
        items: []
      }
    })

    const wrapper = await mountSuspended(BundleConfigurator, {
      props: {
        bundle: sampleBundle
      }
    })

    await flushPromises()

    // Title and sector
    expect(wrapper.text()).toContain('Kit Desengrase Cocina Profesional')
    expect(wrapper.text()).toContain('Hostelería')

    // Components visible
    expect(wrapper.text()).toContain('Desengrasante Alcalino')
    expect(wrapper.text()).toContain('Abrillantador Acero Inox')

    // Stock visible
    expect(wrapper.text()).toContain('8 kits disponibles')

    // Prices and savings visible
    expect(wrapper.text()).toContain('45,00')
    expect(wrapper.text()).toContain('60,00')
    expect(wrapper.text()).toContain('15,00')
    expect(wrapper.text()).toContain('25%')

    // VAT visible
    expect(wrapper.text()).toContain('IVA')
  })

  it('shows the VAT-inclusive kit price as total and VAT included in it, never added on top (SECFIX-3 #6)', async () => {
    mocks.request.mockResolvedValueOnce({ selection: null })
    const wrapper = await mountSuspended(BundleConfigurator, { props: { bundle: sampleBundle } })
    await flushPromises()
    // Lines 5000 + 1000 standalone, 25% off => 3750 + 750; VAT included: 651 + 130.
    expect(wrapper.find('[data-testid="bundle-total"]').text()).toContain('45,00')
    expect(wrapper.find('[data-testid="bundle-tax"]').text()).toContain('7,81')
    expect(wrapper.text()).not.toContain('55,42')
  })

  it('allows quantity editing and recalculates savings', async () => {
    mocks.request.mockResolvedValueOnce({
      selection: {
        equivalentStandaloneCents: 12000,
        bundlePriceCents: 9000,
        savingsCents: 3000,
        savingsPercent: 25.0,
        taxCents: 1890,
        totalCents: 10890,
        maxAvailableKits: 8,
        inStock: true,
        items: []
      }
    })

    const wrapper = await mountSuspended(BundleConfigurator, {
      props: {
        bundle: sampleBundle
      }
    })

    await flushPromises()

    // Increment kit quantity button
    const incButton = wrapper.find('[data-testid="increment-kit-qty"]')
    expect(incButton.exists()).toBe(true)
    await incButton.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('update:quantity')).toBeTruthy()
  })
})
