import { describe, it, expect } from 'vitest'
import { experimental_readRawConfig } from 'wrangler'
import {
  createDemoConfig,
  DEMO_ACCOUNT,
  DEMO_DATABASE,
  DEMO_WORKER,
  demoProviderContractHolds,
  prepareDemoRedsysSandboxSecret
} from '../../scripts/generate-demo-config'
import { REDSYS_REDIRECT_URLS } from '../../workers/payments/redsys'
import { parseCommercialTerms } from '../../shared/commercial-terms'
import { DEMO_ORIGIN } from '../../shared/demo-access'

describe('isolated Cloudflare demo configuration', () => {
  function config() {
    const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' })
    return createDemoConfig(rawConfig as Record<string, unknown>, process.cwd())
  }
  it('carries the supplied checkout identity into the Worker compiler definitions', () => {
    const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' })
    const sha = 'a'.repeat(40)
    expect(createDemoConfig(rawConfig as Record<string, unknown>, process.cwd(), sha).define).toEqual({
      __NETECO_BUILD_COMMIT__: JSON.stringify(sha)
    })
    expect(() => createDemoConfig(rawConfig as Record<string, unknown>, process.cwd(), 'invalid')).toThrow(
      'build_commit_invalid'
    )
  })
  it('uses the isolated database, bucket, KV and worker, never production landing', () => {
    const output = config()
    expect(output.name).toBe(DEMO_WORKER)
    expect(output.account_id).toBe(DEMO_ACCOUNT)
    expect(output.d1_databases[0]?.database_id).toBe(DEMO_DATABASE)
    expect(output.r2_buckets).toEqual([{ binding: 'MEDIA', bucket_name: 'neteco-preprod-media', jurisdiction: 'eu' }])
    expect(output.workers_dev).toBe(false)
    expect(output.preview_urls).toBe(false)
    expect(output.routes).toEqual([])
  })
  it('has no outbound transport or background dispatch resources', () => {
    const output = config()
    for (const key of ['send_email', 'queues', 'workflows', 'triggers', 'secrets'])
      expect(output).not.toHaveProperty(key)
    for (const key of [
      'BEPLY_ENABLED',
      'FISCAL_ISSUANCE_ENABLED',
      'REFUND_DISPATCH_ENABLED',
      'CREDIT_DISPATCH_ENABLED',
      'AUTH_EMAIL_ENABLED',
      'NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED',
      'INVOICE_EMAIL_ENABLED'
    ])
      expect(output.vars[key]).toBe('false')
  })
  it('aligns preview authentication and public runtime without granting production access', () => {
    const output = config()
    expect(output.vars.APP_ENV).toBe('preview')
    expect(output.vars.CSP_MODE).toBe('enforce')
    expect(output.vars.DEMO_ENABLED).toBe('true')
    expect(output.vars.NUXT_PUBLIC_DEMO_ENABLED).toBe('true')
    for (const key of [
      'AUTH_ORIGIN',
      'PUBLIC_SITE_ORIGIN',
      'MEDIA_ADMIN_ORIGIN',
      'PAYMENT_PUBLIC_BASE_URL',
      'NEWSLETTER_PUBLIC_ORIGIN',
      'NUXT_PUBLIC_BASE_URL'
    ])
      expect(output.vars[key]).toBe(DEMO_ORIGIN)
    expect(JSON.stringify(output)).not.toContain('neteco-landing')
  })

  it('enables Redsys only against the public sandbox merchant and test endpoint', () => {
    const output = config()
    expect(output.vars).toMatchObject({
      REDSYS_ENABLED: 'true',
      REDSYS_ENVIRONMENT: 'sandbox',
      REDSYS_MERCHANT_CODE: '999008881',
      REDSYS_TERMINAL: '1',
      REDSYS_BIZUM_ENABLED: 'false'
    })
    expect(new URL(REDSYS_REDIRECT_URLS[output.vars.REDSYS_ENVIRONMENT as 'sandbox']).hostname).toBe('sis-t.redsys.es')
    expect(demoProviderContractHolds(output.vars)).toBe(true)
  })
  it('rejects any production Redsys endpoint, merchant or other outbound provider in the demo contract', () => {
    const vars = config().vars
    expect(demoProviderContractHolds({ ...vars, REDSYS_ENVIRONMENT: 'production' })).toBe(false)
    expect(demoProviderContractHolds({ ...vars, REDSYS_MERCHANT_CODE: '123456789' })).toBe(false)
    expect(demoProviderContractHolds({ ...vars, REDSYS_TERMINAL: '2' })).toBe(false)
    expect(demoProviderContractHolds({ ...vars, REDSYS_BIZUM_ENABLED: 'true' })).toBe(false)
    expect(demoProviderContractHolds({ ...vars, REDSYS_ENABLED: 'false' })).toBe(true)
    for (const key of ['BEPLY_ENABLED', 'FISCAL_ISSUANCE_ENABLED', 'TRANSACTIONAL_EMAIL_ENABLED', 'AUTH_EMAIL_ENABLED'])
      expect(demoProviderContractHolds({ ...vars, [key]: 'true' })).toBe(false)
  })
  it('provisions only the public Redsys sandbox signing key and never replaces an existing one', () => {
    expect(prepareDemoRedsysSandboxSecret(new Set())).toEqual({
      REDSYS_SECRET_KEY: { name: 'REDSYS_SECRET_KEY', type: 'secret_text', text: 'sq7HjrUOBfKmC576ILgskD5srU870gJ7' }
    })
    expect(prepareDemoRedsysSandboxSecret(new Set(['REDSYS_SECRET_KEY']))).toEqual({})
  })

  it('publishes the provisional commercial terms through the real runtime parser', () => {
    const vars = config().vars as Record<string, string>
    const prefix = 'NUXT_PUBLIC_COMMERCIAL_'
    const commercial = Object.fromEntries(
      Object.entries(vars)
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => [
          name
            .slice(prefix.length)
            .toLowerCase()
            .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          value
        ])
    )
    expect(parseCommercialTerms(commercial)).toMatchObject({
      ownDeliveryDays: "martes y jueves (Ontinyent y la Vall d'Albaida)",
      orderCutoffTime: '13:00',
      ownDeliveryCostCents: 600,
      ownDeliveryFreeFromCents: 15000,
      ownDeliveryMinimumOrderCents: 3000,
      parcelLeadTime: '24-72 h',
      parcelCostCents: 990,
      deferredPaymentDays: 30,
      deferredPaymentConditions: '30 días fecha factura para empresas aprobadas',
      supportHours: 'Lunes a viernes, 8:00-14:00 y 16:00-19:00',
      contactEmail: 'tienda@neteco.es',
      contactPhone: '600 861 334',
      foundedYear: 1998,
      companyTaxId: 'B00000000',
      companyAddress: 'Polígono Industrial El Pla, 46870 Ontinyent (Valencia)',
      companyLegalName: 'Neteco Suministros Profesionales, S.L. (provisional)',
      companyRegistry: 'Registro Mercantil de Valencia (datos provisionales)',
      dpoEmail: 'tienda@neteco.es',
      disputeResolutionEntity: 'Junta Arbitral de Consumo de la Comunitat Valenciana'
    })
    expect(vars.FREE_SHIPPING_THRESHOLD_CENTS).toBe('15000')
    expect(vars.NUXT_PUBLIC_FREE_SHIPPING_THRESHOLD_CENTS).toBe('15000')
  })
})
