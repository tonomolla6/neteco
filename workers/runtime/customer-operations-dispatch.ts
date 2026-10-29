import { dispatchD1Refunds } from '../refunds/operations'
import { readFinancialPolicy } from '../refunds/policies'
import { dispatchD1CreditNotes } from '../fiscal/credit-notes'
import { dispatchNewsletterCampaigns } from '../marketing/newsletter-campaign-delivery'
import { createFiscalPdfStorage } from './fiscal-pdf-storage'
import { cmsRuntimeDependencies } from './operations-config'
import {
  configuredRefundProvider,
  configuredCreditProvider,
  configuredNewsletterEditorial,
  financialRuntimeConfiguration,
  type CustomerOperationsEnv
} from './customer-operations-config'

export async function dispatchCustomerFinancialOperations(env: CustomerOperationsEnv, now: string) {
  const config = financialRuntimeConfiguration(env),
    report = { refundsCompleted: 0, creditsCompleted: 0, uncertain: 0, blocked: 0, disabled: !config.enabled }
  // Core dispatchers reconcile stale markers before their own enabled checks.
  // Therefore the outer gate must precede even D1 access when the feature is OFF.
  if (!config.enabled) return report
  if (config.refunds.enabled) {
    for (const id of config.refunds.policyIds) {
      const policy = await readFinancialPolicy(env.DB, id, 'refund')
      if (!policy) continue
      const provider = await configuredRefundProvider(env, policy, fetch)
      const result = await dispatchD1Refunds(env.DB, provider ?? undefined, {
        now,
        appEnvironment: config.appEnvironment,
        ...config.refunds,
        policyId: id,
        limit: 25
      })
      report.refundsCompleted += result.completed
      report.uncertain += result.uncertain
      report.blocked += result.blocked
    }
  }
  if (config.credits.enabled) {
    const storage = createFiscalPdfStorage(env.MEDIA)
    for (const id of config.credits.policyIds) {
      const policy = await readFinancialPolicy(env.DB, id, 'credit')
      if (!policy) continue
      const provider = await configuredCreditProvider(env, policy, fetch)
      const result = await dispatchD1CreditNotes(env.DB, provider ?? undefined, storage, {
        now,
        appEnvironment: config.appEnvironment,
        ...config.credits,
        policyId: id,
        limit: 25
      })
      report.creditsCompleted += result.completed
      report.uncertain += result.uncertain
      report.blocked += result.blocked
    }
  }
  return report
}

export async function dispatchConfiguredNewsletterCampaigns(env: CustomerOperationsEnv) {
  const deps = configuredNewsletterEditorial(env)
  if (!deps.enabled || deps.transport?.mode === 'disabled') return { disabled: true }
  deps.cmsPublication = cmsRuntimeDependencies(env)
  return dispatchNewsletterCampaigns(deps, { limit: 25 })
}
