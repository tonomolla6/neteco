import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRecurringIncentivesPanel from '../../app/components/AdminRecurringIncentivesPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockAgreement = {
  agreement: {
    id: 'agr-1',
    companyId: 'comp-turia',
    contractRef: 'CTR-B2B-TURIA-2026',
    contractTermsVersion: '2026.1',
    contractSignedAt: '2026-01-10T10:00:00Z',
    periodFrequency: 'quarterly',
    volumeTiers: [
      { minVolumeCents: 300000, rebatePercentBasisPoints: 200 },
      { minVolumeCents: 1000000, rebatePercentBasisPoints: 400 }
    ],
    minGrossMarginBasisPoints: 2000,
    slaPunctualPaymentRequired: true,
    slaMinAvgOrderNetCents: 50000,
    slaEinvoiceRequired: true,
    fiscalNotes: 'Rappel comercial regulado conforme Art. 80 Ley 37/1992 del IVA.',
    fiscalVatTreatment: 'credit_note_art80_liva',
    fiscalReviewStatus: 'pending_review',
    status: 'active',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
}

describe('AdminRecurringIncentivesPanel.vue', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders agreement details, contract reference, fiscal notes, and transparent tiers without points', async () => {
    mocks.request.mockResolvedValueOnce(mockAgreement)

    const wrapper = await mountSuspended(AdminRecurringIncentivesPanel, {
      props: { companyId: 'comp-turia' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('CTR-B2B-TURIA-2026')
    expect(wrapper.text()).toContain('Art. 80 Ley 37/1992')
    expect(wrapper.text()).toContain('Tramos por volumen')
    // Transparent calculation, no opaque points
    expect(wrapper.text()).not.toContain('puntos de fidelidad')
  })
})
