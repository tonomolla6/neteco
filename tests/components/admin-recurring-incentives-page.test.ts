import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRecurringIncentivesPage from '../../app/pages/admin/incentivos-recurrentes.vue'
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
    volumeTiers: [{ minVolumeCents: 300000, rebatePercentBasisPoints: 200 }],
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

describe('AdminRecurringIncentivesPage', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders company selector and mounts the recurring incentives panel', async () => {
    mocks.request.mockResolvedValueOnce(mockAgreement)

    const wrapper = await mountSuspended(AdminRecurringIncentivesPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Incentivos por Recurrencia B2B')
    expect(wrapper.find('[data-test="company-input"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('CTR-B2B-TURIA-2026')
  })
})
