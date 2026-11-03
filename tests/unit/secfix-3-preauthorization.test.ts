import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCustomerRiskScoringHttp } from '../../workers/crm/risk-scoring-http'
import { handleCompanyShippingConditionsHttp } from '../../workers/fulfillment/company-shipping-conditions-http'
import { calculateCustomerRiskScore, reviewCustomerRiskScore } from '../../workers/crm/risk-scoring'
import { setCompanyShippingConditions } from '../../workers/fulfillment/company-shipping-conditions'

vi.mock('../../workers/auth/session-cookie', () => ({
  verifySessionCookie: vi.fn(async () => ({ identityId: 'admin' }))
}))
vi.mock('../../workers/crm/risk-scoring', () => ({
  calculateCustomerRiskScore: vi.fn(async () => ({})),
  reviewCustomerRiskScore: vi.fn(async () => ({})),
  getCustomerScoringProfile: vi.fn(),
  evaluateScoringModelQuality: vi.fn()
}))
vi.mock('../../workers/fulfillment/company-shipping-conditions', () => ({
  setCompanyShippingConditions: vi.fn(async () => ({})),
  getCompanyShippingConditions: vi.fn(),
  CompanyShippingConditionsError: class extends Error {}
}))

beforeEach(() => vi.clearAllMocks())

describe('SECFIX-3 authorization before writes', () => {
  it.each(['calculate', 'review'])('does not persist a risk %s when authorization changes', async (action) => {
    let checks = 0
    const database = { prepare: () => ({ bind: () => ({ first: async () => (++checks === 1 ? { ok: 1 } : null) }) }) }
    const response = await handleCustomerRiskScoringHttp(
      new Request(`https://shop.invalid/api/admin/scoring/profiles/customer/${action}`, {
        method: 'POST',
        body: JSON.stringify({ commercialMetrics: {}, action: 'review' })
      }),
      { database: database as never, sessionCookieConfiguration: { password: 'p'.repeat(64), maxAgeSeconds: 3600 } }
    )
    expect(response?.status).toBe(403)
    expect(calculateCustomerRiskScore).not.toHaveBeenCalled()
    expect(reviewCustomerRiskScore).not.toHaveBeenCalled()
  })

  it('does not persist company shipping conditions after authorization is revoked', async () => {
    const sessionProvider = vi
      .fn()
      .mockResolvedValueOnce({ identityId: 'admin', roles: ['admin'], permissions: [] })
      .mockResolvedValueOnce(null)
    const response = await handleCompanyShippingConditionsHttp(
      new Request('https://shop.invalid/api/admin/companies/company/shipping-conditions', {
        method: 'PUT',
        body: JSON.stringify({ companyId: 'company', allowedMethods: ['pickup'], expectedVersion: 0, commandId: 'cmd' })
      }),
      { database: {} as never, sessionProvider }
    )
    expect(response?.status).toBe(403)
    expect(setCompanyShippingConditions).not.toHaveBeenCalled()
  })
})
