import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { z } from 'zod'
import {
  fiscalInstant,
  fiscalUuid,
  type FiscalPolicy,
  type OrdinaryFiscalProvider,
  type PrivateFiscalStorage
} from '../../shared/fiscal-issuance'
import { dispatchFiscalIssuance, fiscalMappingFingerprint, readFiscalPolicy } from './issuance'

export interface FiscalRuntimeDependencies {
  database: D1Database
  storage?: PrivateFiscalStorage
  /** Server-owned injection only. There is deliberately no default factory/fetch. */
  providerResolver?: (policy: FiscalPolicy) => OrdinaryFiscalProvider | null | Promise<OrdinaryFiscalProvider | null>
}
export interface FiscalRuntimeConfiguration {
  appEnvironment: 'local' | 'preview' | 'production'
  now: string
  flags?: { enabled?: unknown; localValidationEnabled?: unknown }
  /** Explicit server allowlist; an approved D1 policy alone never enables work. */
  policyIds?: readonly string[]
  limit?: number
}
export interface FiscalRuntimeReport {
  disabled: boolean
  completed: number
  uncertain: number
  blocked: number
  lostLease: number
  policies: number
  unavailable: number
}
function enabled(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false
  if (value === true || value === 'true') return true
  throw new Error('fiscal_runtime_configuration_invalid')
}
const configurationSchema = z
  .object({
    appEnvironment: z.enum(['local', 'preview', 'production']),
    now: fiscalInstant,
    flags: z
      .object({ enabled: z.unknown().optional(), localValidationEnabled: z.unknown().optional() })
      .strict()
      .optional(),
    policyIds: z.array(fiscalUuid).max(10).optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()
function providerField(provider: OrdinaryFiscalProvider, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(provider, name)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
/** Governed scheduled/Queue executor. Only already-owned durable intents run;
 * this never approves a policy, queues a paid order or retries uncertain work. */
export async function dispatchFiscalRuntime(
  dependencies: FiscalRuntimeDependencies,
  configuration: FiscalRuntimeConfiguration
): Promise<FiscalRuntimeReport> {
  const config = configurationSchema.parse(catalogPolicyOwnJson(configuration))
  const limit = config.limit ?? 25
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    Object.keys(config).some((key) => !['appEnvironment', 'now', 'flags', 'policyIds', 'limit'].includes(key))
  )
    throw new Error('fiscal_runtime_configuration_invalid')
  if (config.flags && Object.keys(config.flags).some((key) => !['enabled', 'localValidationEnabled'].includes(key)))
    throw new Error('fiscal_runtime_configuration_invalid')
  const optIn = enabled(config.flags?.enabled),
    localOptIn = enabled(config.flags?.localValidationEnabled)
  const ids = config.policyIds ?? []
  if (
    !Array.isArray(ids) ||
    ids.length > 10 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !fiscalUuid.safeParse(id).success)
  )
    throw new Error('fiscal_runtime_configuration_invalid')
  // Even with issuance off, quarantine expired markers; never call a resolver.
  const sweep = await dispatchFiscalIssuance(dependencies.database, undefined, undefined, {
    now: config.now,
    appEnvironment: config.appEnvironment,
    limit,
    allowProviderIssuance: false
  })
  const report: FiscalRuntimeReport = { ...sweep, disabled: !optIn || ids.length === 0, policies: 0, unavailable: 0 }
  if (report.disabled) return report
  let remaining = limit
  for (const id of ids) {
    if (remaining <= 0) break
    const policy = await readFiscalPolicy(dependencies.database, id)
    const expectedEnvironment =
      config.appEnvironment === 'local'
        ? 'local_validation'
        : config.appEnvironment === 'preview'
          ? 'sandbox'
          : 'production'
    if (
      !policy ||
      policy.environment !== expectedEnvironment ||
      (policy.provider === 'local_fake' && !localOptIn) ||
      !dependencies.storage ||
      !dependencies.providerResolver
    ) {
      report.unavailable++
      continue
    }
    // Resolving an adapter cannot grant authority. Re-read after that await.
    let provider: OrdinaryFiscalProvider | null
    try {
      provider = await dependencies.providerResolver(policy)
    } catch {
      report.unavailable++
      continue
    }
    const current = await readFiscalPolicy(dependencies.database, id)
    if (
      !provider ||
      !current ||
      current.fingerprint !== policy.fingerprint ||
      providerField(provider, 'name') !== policy.provider ||
      providerField(provider, 'environment') !== policy.environment ||
      providerField(provider, 'mappingFingerprint') !== (await fiscalMappingFingerprint(policy.mappings))
    ) {
      report.unavailable++
      continue
    }
    const result = await dispatchFiscalIssuance(dependencies.database, provider, dependencies.storage, {
      now: config.now,
      appEnvironment: config.appEnvironment,
      limit: remaining,
      allowProviderIssuance: true,
      policyId: id
    })
    report.policies++
    report.completed += result.completed
    report.uncertain += result.uncertain
    report.blocked += result.blocked
    report.lostLease += result.lostLease
    remaining -= result.completed + result.uncertain + result.blocked + result.lostLease
  }
  return report
}
