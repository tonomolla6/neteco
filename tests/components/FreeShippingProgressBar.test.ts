import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FreeShippingProgressBar from '../../app/components/FreeShippingProgressBar.vue'

describe('FreeShippingProgressBar.vue (MKT-022)', () => {
  it('renders in_progress state with missing amount and progress bar', () => {
    const wrapper = mount(FreeShippingProgressBar, {
      props: {
        evaluation: {
          status: 'in_progress',
          eligible: true,
          canBecomeFree: true,
          reason: 'below_threshold',
          thresholdGrossCents: 15000,
          subtotalGrossCents: 9000,
          progressPercent: 60,
          missingCents: 6000,
          badgeText: 'Faltan 60,00 € para portes gratis',
          message: 'Añade 60,00 € más a tu cesta para conseguir portes gratis en paquetería estándar peninsular.',
          detailedExplanation: 'Umbral de envío gratuito fijado en 150,00 €.',
          effectiveProfile: 'parcel',
          effectiveZone: 'peninsular'
        }
      }
    })

    expect(wrapper.text().replace(/\s+/g, ' ')).toContain('60,00 €')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true)
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('60')
  })

  it('renders reached state with green checkmark and zero missing cents', () => {
    const wrapper = mount(FreeShippingProgressBar, {
      props: {
        evaluation: {
          status: 'reached',
          eligible: true,
          canBecomeFree: true,
          reason: 'granted',
          thresholdGrossCents: 15000,
          subtotalGrossCents: 18000,
          progressPercent: 100,
          missingCents: 0,
          badgeText: '¡Portes gratis conseguidos!',
          message: '¡Has alcanzado el umbral para paquetería estándar peninsular gratuita!',
          detailedExplanation: 'Tu pedido cumple todos los requisitos.',
          effectiveProfile: 'parcel',
          effectiveZone: 'peninsular'
        }
      }
    })

    expect(wrapper.text()).toContain('alcanzado el umbral')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
  })

  it('renders ADR exclusion clearly and does NOT show a progress bar towards free shipping', () => {
    const wrapper = mount(FreeShippingProgressBar, {
      props: {
        evaluation: {
          status: 'excluded',
          eligible: false,
          canBecomeFree: false,
          reason: 'adr_excluded',
          thresholdGrossCents: 15000,
          subtotalGrossCents: 20000,
          progressPercent: 0,
          missingCents: 0,
          badgeText: 'Mercancía peligrosa ADR (no elegible para portes gratis)',
          message:
            'Tu cesta contiene productos con perfil ADR / mercancías peligrosas sujetos a normativa de transporte especial.',
          detailedExplanation: 'Los productos químicos clasificados como ADR requieren transportista especializado.',
          effectiveProfile: 'adr',
          effectiveZone: 'peninsular'
        }
      }
    })

    expect(wrapper.text()).toContain('ADR')
    expect(wrapper.text()).toContain('transporte especial')
    // Must NOT have active progress bar or false promise
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('conseguir portes gratis')
  })

  it('renders pallet exclusion clearly with reason and no misleading progress', () => {
    const wrapper = mount(FreeShippingProgressBar, {
      props: {
        evaluation: {
          status: 'excluded',
          eligible: false,
          canBecomeFree: false,
          reason: 'pallet_excluded',
          thresholdGrossCents: 15000,
          subtotalGrossCents: 25000,
          progressPercent: 0,
          missingCents: 0,
          badgeText: 'Transporte en palé (no elegible para paquetería gratuita)',
          message: 'El peso total del pedido supera los 20 kg y requiere transporte sobre palé.',
          detailedExplanation: 'Las expediciones paletizadas conllevan manipulación logística pesada.',
          effectiveProfile: 'pallet',
          effectiveZone: 'peninsular'
        }
      }
    })

    expect(wrapper.text()).toMatch(/palé|20 kg/i)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })
})
