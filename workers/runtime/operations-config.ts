import { fiscalUuid, type FiscalPolicy, type OrdinaryFiscalProvider } from '../../shared/fiscal-issuance'
import { fiscalMappingFingerprint } from '../fiscal/issuance'
import { PersistentLocalFiscalProvider } from '../fiscal/local-provider'
import { WorkerBeplyInvoiceProvider } from '../fiscal/beply-provider'
import type { FiscalRuntimeConfiguration } from '../fiscal/runtime-dispatch'
import type { CmsPublicationDependencies } from '../cms/publication-gate'

/** Optional secrets are runtime-injected, never public vars, inferred .env
 * values, fallbacks, or required credentials when a feature is disabled. */
type OperationsEnv = Pick<CloudflareEnv, 'APP_ENV' | 'DB' | 'MEDIA' | 'IMAGES' | 'AUTH_ORIGIN'> & {
  CMS_PUBLICATION_ENABLED?: unknown
  CMS_PREVIEW_ENABLED?: unknown
  CMS_PREVIEW_SECRET?: unknown
  FISCAL_ISSUANCE_ENABLED?: unknown
  FISCAL_LOCAL_VALIDATION_ENABLED?: unknown
  FISCAL_POLICY_IDS?: unknown
  BEPLY_ENABLED?: unknown
  BEPLY_ENVIRONMENT?: unknown
  BEPLY_BASE_URL?: unknown
  BEPLY_API_TOKEN?: unknown
  BEPLY_INVOICE_SERIES?: unknown
  BEPLY_CORRECTIVE_SERIES?: unknown
  BEPLY_COMPANY_ID?: unknown
  BEPLY_TAX_CODE_0?: unknown
  BEPLY_TAX_CODE_10?: unknown
  BEPLY_TAX_CODE_21?: unknown
  BEPLY_PAYMENT_CODE_REDSYS?: unknown
  BEPLY_PAYMENT_CODE_BANK_TRANSFER?: unknown
}
function flag(value: unknown) {
  if (value === undefined || value === false || value === 'false') return false
  if (value === true || value === 'true') return true
  throw new Error('operations_configuration_invalid')
}
export { flag as operationFlag }
export function operationsEnvironment(value: string): 'local' | 'preview' | 'production' {
  if (value === 'local' || value === 'production') return value
  if (['preview', 'preprod', 'preproduction', 'canary'].includes(value)) return 'preview'
  throw new Error('operations_configuration_invalid')
}
export function cmsRuntimeDependencies(env: OperationsEnv): CmsPublicationDependencies {
  const enabled = flag(env.CMS_PUBLICATION_ENABLED),
    preview = flag(env.CMS_PREVIEW_ENABLED)
  return {
    database: env.DB,
    enabled,
    bucket: env.MEDIA,
    images: env.IMAGES,
    ...(enabled && preview && typeof env.CMS_PREVIEW_SECRET === 'string'
      ? { preview: { secret: env.CMS_PREVIEW_SECRET, origin: env.AUTH_ORIGIN } }
      : {})
  }
}
export function fiscalRuntimeConfiguration(env: OperationsEnv, now: string): FiscalRuntimeConfiguration {
  let policyIds: string[] = []
  if (env.FISCAL_POLICY_IDS !== undefined) {
    if (typeof env.FISCAL_POLICY_IDS !== 'string' || env.FISCAL_POLICY_IDS.length > 4096)
      throw new Error('operations_configuration_invalid')
    let value: unknown
    try {
      value = JSON.parse(env.FISCAL_POLICY_IDS)
    } catch {
      throw new Error('operations_configuration_invalid')
    }
    if (
      !Array.isArray(value) ||
      value.length > 10 ||
      new Set(value).size !== value.length ||
      value.some((id) => !fiscalUuid.safeParse(id).success)
    )
      throw new Error('operations_configuration_invalid')
    policyIds = value
  }
  return {
    appEnvironment: operationsEnvironment(env.APP_ENV),
    now,
    flags: {
      enabled: flag(env.FISCAL_ISSUANCE_ENABLED),
      localValidationEnabled: flag(env.FISCAL_LOCAL_VALIDATION_ENABLED)
    },
    policyIds,
    limit: 25
  }
}
/** Selection and dispatch are separate gates in dispatchFiscalRuntime. This
 * factory does not approve, queue, issue, download, or contact any provider. */
export async function configuredFiscalProvider(
  env: OperationsEnv,
  policy: FiscalPolicy,
  fetcher: typeof fetch
): Promise<OrdinaryFiscalProvider | null> {
  const environment = operationsEnvironment(env.APP_ENV)
  if (policy.provider === 'local_fake')
    return environment === 'local' &&
      policy.environment === 'local_validation' &&
      flag(env.FISCAL_LOCAL_VALIDATION_ENABLED)
      ? new PersistentLocalFiscalProvider(env.DB, await fiscalMappingFingerprint(policy.mappings))
      : null
  return configuredBeplyProvider(env, policy, 'ordinary', fetcher)
}

/** Both document kinds share the same tenant, environment and tax authority;
 * their separately approved series never authorize the other document kind. */
export async function configuredBeplyProvider(
  env: OperationsEnv,
  policy: Pick<FiscalPolicy, 'environment' | 'series' | 'mappings'>,
  kind: 'ordinary' | 'corrective',
  fetcher: typeof fetch
): Promise<WorkerBeplyInvoiceProvider | null> {
  const environment = operationsEnvironment(env.APP_ENV)
  if (
    !flag(env.BEPLY_ENABLED) ||
    environment === 'local' ||
    policy.environment === 'local_validation' ||
    env.BEPLY_ENVIRONMENT !== policy.environment ||
    policy.environment !== (environment === 'preview' ? 'sandbox' : 'production') ||
    (kind === 'ordinary' ? env.BEPLY_INVOICE_SERIES : env.BEPLY_CORRECTIVE_SERIES) !== policy.series
  )
    return null
  const values = {
    baseUrl: env.BEPLY_BASE_URL,
    token: env.BEPLY_API_TOKEN,
    invoiceSeries: env.BEPLY_INVOICE_SERIES,
    correctiveSeries: env.BEPLY_CORRECTIVE_SERIES,
    taxCode0: env.BEPLY_TAX_CODE_0,
    taxCode10: env.BEPLY_TAX_CODE_10,
    taxCode21: env.BEPLY_TAX_CODE_21,
    paymentCodeRedsys: env.BEPLY_PAYMENT_CODE_REDSYS,
    paymentCodeBankTransfer: env.BEPLY_PAYMENT_CODE_BANK_TRANSFER,
    companyId: env.BEPLY_COMPANY_ID
  }
  // Construct a typed existing provider contract only from explicit strings.
  const {
    baseUrl,
    token,
    invoiceSeries,
    correctiveSeries,
    taxCode0,
    taxCode10,
    taxCode21,
    paymentCodeRedsys,
    paymentCodeBankTransfer,
    companyId
  } = values
  if (
    typeof baseUrl !== 'string' ||
    typeof token !== 'string' ||
    typeof invoiceSeries !== 'string' ||
    typeof correctiveSeries !== 'string' ||
    typeof taxCode0 !== 'string' ||
    typeof taxCode10 !== 'string' ||
    typeof taxCode21 !== 'string' ||
    typeof paymentCodeRedsys !== 'string' ||
    typeof paymentCodeBankTransfer !== 'string' ||
    typeof companyId !== 'string'
  )
    return null
  try {
    // The business explicitly identified this tenant as PRODUCTION. Merely
    // relabelling it as sandbox must never make preview contact it.
    if (new URL(baseUrl).hostname === 'neteco.beply.es' && environment !== 'production') return null
  } catch {
    return null
  }
  const configuration = {
    baseUrl,
    token,
    invoiceSeries,
    correctiveSeries,
    taxCode0,
    taxCode10,
    taxCode21,
    paymentCodeRedsys,
    paymentCodeBankTransfer,
    companyId,
    environment: policy.environment
  }
  if (
    (await fiscalMappingFingerprint({
      companyId,
      taxes: { '0': taxCode0, '1000': taxCode10, '2100': taxCode21 },
      paymentCode: paymentCodeRedsys
    })) !== (await fiscalMappingFingerprint(policy.mappings))
  )
    return null
  return WorkerBeplyInvoiceProvider.create(configuration, fetcher)
}
