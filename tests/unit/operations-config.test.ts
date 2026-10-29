import { describe, expect, it, vi } from 'vitest'
import {
  cmsRuntimeDependencies,
  configuredFiscalProvider,
  fiscalRuntimeConfiguration,
  operationsEnvironment
} from '../../workers/runtime/operations-config'
import type { FiscalPolicy } from '../../shared/fiscal-issuance'

const ID = '10000000-0000-4000-8000-000000000043'
const NOW = '2026-10-03T00:00:00Z'
const policy: FiscalPolicy = {
  id: ID,
  idempotencyKey: 'synthetic-policy',
  environment: 'sandbox',
  provider: 'beply',
  series: 'WEB',
  trigger: 'after_payment_capture',
  mappings: {
    companyId: 'LOCAL-TEST',
    taxes: { '0': 'ZERO', '1000': 'REDUCED', '2100': 'GENERAL' },
    paymentCode: 'CARD'
  },
  evidenceRef: 'synthetic-no-acceptance',
  reason: 'Synthetic configuration test only',
  approvedAt: NOW,
  fingerprint: 'a'.repeat(64)
}
function environment() {
  return {
    APP_ENV: 'preprod',
    DB: {},
    MEDIA: {},
    IMAGES: {},
    AUTH_ORIGIN: 'https://neteco.invalid'
  } as unknown as CloudflareEnv
}
describe('explicit governed operations runtime configuration', () => {
  it.each([
    ['local', 'local'],
    ['preview', 'preview'],
    ['preprod', 'preview'],
    ['preproduction', 'preview'],
    ['canary', 'preview'],
    ['production', 'production']
  ] as const)('maps %s without turning a sandbox into local fake acceptance', (value, expected) =>
    expect(operationsEnvironment(value)).toBe(expected)
  )
  it.each(['audit', 'staging', 'PRODUCTION', '', 'unknown'])('fails closed for %s', (value) =>
    expect(() => operationsEnvironment(value)).toThrow()
  )
  it('defaults every fiscal opt-in and selection off', () => {
    expect(fiscalRuntimeConfiguration(environment(), NOW)).toEqual({
      appEnvironment: 'preview',
      now: NOW,
      flags: { enabled: false, localValidationEnabled: false },
      policyIds: [],
      limit: 25
    })
  })
  it('accepts only an explicit bounded unique UUID policy allowlist', () => {
    const env = {
      ...environment(),
      FISCAL_ISSUANCE_ENABLED: 'true',
      FISCAL_LOCAL_VALIDATION_ENABLED: 'false',
      FISCAL_POLICY_IDS: JSON.stringify([ID])
    }
    expect(fiscalRuntimeConfiguration(env, NOW)).toMatchObject({
      flags: { enabled: true, localValidationEnabled: false },
      policyIds: [ID]
    })
  })
  it.each(['', '{}', '[1]', JSON.stringify([ID, ID]), JSON.stringify(Array(11).fill(ID)), 'x'.repeat(4097)])(
    'rejects malformed policy configuration %# before provider creation',
    (value) => {
      expect(() => fiscalRuntimeConfiguration({ ...environment(), FISCAL_POLICY_IDS: value }, NOW)).toThrow(
        'operations_configuration_invalid'
      )
    }
  )
  it.each(['TRUE', 'yes', 1, null])('does not coerce invalid opt-in %#', (value) => {
    expect(() => fiscalRuntimeConfiguration({ ...environment(), FISCAL_ISSUANCE_ENABLED: value }, NOW)).toThrow(
      'operations_configuration_invalid'
    )
  })
  it('keeps CMS preview disabled unless publication and a separate preview opt-in exist', () => {
    const secret = 'synthetic-preview-fixture-has-at-least-forty-eight-distinct-safe-characters'
    expect(cmsRuntimeDependencies({ ...environment(), CMS_PREVIEW_SECRET: secret }).preview).toBeUndefined()
    expect(
      cmsRuntimeDependencies({
        ...environment(),
        CMS_PUBLICATION_ENABLED: 'false',
        CMS_PREVIEW_ENABLED: 'true',
        CMS_PREVIEW_SECRET: secret
      })
    ).toMatchObject({ enabled: false })
    expect(
      cmsRuntimeDependencies({
        ...environment(),
        CMS_PUBLICATION_ENABLED: 'false',
        CMS_PREVIEW_ENABLED: 'true',
        CMS_PREVIEW_SECRET: secret
      }).preview
    ).toBeUndefined()
    expect(
      cmsRuntimeDependencies({ ...environment(), CMS_PUBLICATION_ENABLED: 'true', CMS_PREVIEW_SECRET: secret }).preview
    ).toBeUndefined()
    expect(
      cmsRuntimeDependencies({
        ...environment(),
        CMS_PUBLICATION_ENABLED: 'true',
        CMS_PREVIEW_ENABLED: 'true',
        CMS_PREVIEW_SECRET: secret
      }).preview
    ).toEqual({ secret, origin: 'https://neteco.invalid' })
  })
  it('never creates or contacts a real provider from a policy, token or local-validation flag alone', async () => {
    const fetcher = vi.fn()
    for (const env of [
      environment(),
      { ...environment(), BEPLY_API_TOKEN: 'synthetic-not-a-real-token' },
      { ...environment(), BEPLY_ENABLED: 'true', APP_ENV: 'local' }
    ]) {
      expect(await configuredFiscalProvider(env, policy, fetcher)).toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('requires a separate local opt-in and local policy environment for the durable local fake', async () => {
    const local = { ...policy, provider: 'local_fake' as const, environment: 'local_validation' as const },
      fetcher = vi.fn()
    expect(await configuredFiscalProvider({ ...environment(), APP_ENV: 'local' }, local, fetcher)).toBeNull()
    expect(
      await configuredFiscalProvider({ ...environment(), FISCAL_LOCAL_VALIDATION_ENABLED: 'true' }, local, fetcher)
    ).toBeNull()
    const configured = await configuredFiscalProvider(
      { ...environment(), APP_ENV: 'local', FISCAL_LOCAL_VALIDATION_ENABLED: 'true' },
      local,
      fetcher
    )
    expect(configured?.name).toBe('local_fake')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('can construct a wholly explicit matching sandbox adapter offline without initiating an API call', async () => {
    const fetcher = vi.fn(),
      env = {
        ...environment(),
        BEPLY_ENABLED: 'true',
        BEPLY_ENVIRONMENT: 'sandbox',
        BEPLY_API_TOKEN: 'synthetic-only-not-real',
        BEPLY_BASE_URL: 'https://fixture.beply.es/api/3',
        BEPLY_INVOICE_SERIES: 'WEB',
        BEPLY_CORRECTIVE_SERIES: 'TEST',
        BEPLY_TAX_CODE_0: 'ZERO',
        BEPLY_TAX_CODE_10: 'REDUCED',
        BEPLY_TAX_CODE_21: 'GENERAL',
        BEPLY_PAYMENT_CODE_REDSYS: 'CARD',
        BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'BANK',
        BEPLY_COMPANY_ID: 'LOCAL-TEST'
      }
    const result = await configuredFiscalProvider(env, policy, fetcher)
    expect(result?.name).toBe('beply')
    expect(result?.environment).toBe('sandbox')
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      await configuredFiscalProvider({ ...env, BEPLY_BASE_URL: 'https://neteco.beply.es/api/3' }, policy, fetcher)
    ).toBeNull()
    for (const patch of [
      { APP_ENV: 'production' },
      { BEPLY_ENVIRONMENT: 'production' },
      { BEPLY_ENABLED: 'false' },
      { BEPLY_ENABLED: undefined },
      { BEPLY_INVOICE_SERIES: 'OTHER' },
      { BEPLY_COMPANY_ID: 'WRONG' },
      { BEPLY_TAX_CODE_21: 'WRONG' },
      { BEPLY_PAYMENT_CODE_REDSYS: 'WRONG' }
    ]) {
      expect(await configuredFiscalProvider({ ...env, ...patch }, policy, fetcher)).toBeNull()
    }
    for (const APP_ENV of ['local', 'preview', 'preprod', 'preproduction', 'canary']) {
      for (const BEPLY_BASE_URL of [
        'https://neteco.beply.es/api/3',
        'https://NETECO.BEPLY.ES/api/3',
        'https://neteco.beply.es:443/api/3'
      ])
        expect(await configuredFiscalProvider({ ...env, APP_ENV, BEPLY_BASE_URL }, policy, fetcher)).toBeNull()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})
