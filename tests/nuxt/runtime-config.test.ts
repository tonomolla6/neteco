import { describe, expect, it } from 'vitest'
import { validateRuntimeConfiguration } from '../../server/utils/runtime-config'

const localConfiguration = {
  appEnv: 'local',
  databaseUrl: 'postgres://neteco:local@localhost:56432/neteco',
  redisUrl: 'redis://localhost:56379/0',
  paymentProvider: 'mock',
  invoiceProvider: 'mock',
  carrierProvider: 'mock',
  emailProvider: 'log',
  bankTransfer: {
    enabled: false,
    iban: '',
    beneficiary: ''
  },
  legal: {
    termsVersion: 'purchase-test',
    privacyVersion: 'privacy-test',
    reviewedAt: ''
  },
  media: {
    storageDirectory: '.data/media',
    clamavHost: '',
    clamavPort: 3310,
    maxBytes: 15_000_000
  },
  auth: {
    tokenPepper: 'local-only-token-pepper-change-me',
    encryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    sessionDays: 30
  },
  redsys: {
    environment: 'sandbox',
    merchantCode: '',
    terminal: '1',
    secretKey: '',
    currency: '978',
    merchantName: 'NETECO'
  },
  beply: {
    baseUrl: 'https://api.beply.es/v3',
    token: '',
    invoiceSeries: '',
    correctiveSeries: '',
    taxCode0: '',
    taxCode10: '',
    taxCode21: '',
    paymentCodeRedsys: '',
    paymentCodeBankTransfer: '',
    companyId: ''
  },
  public: {
    appEnv: 'local',
    baseUrl: 'http://localhost:3000',
    appVersion: 'test',
    priceDisplayMode: 'gross',
    legalTermsUrl: 'https://neteco.es/legal',
    privacyUrl: 'https://neteco.es/legal',
    cookiesUrl: 'https://neteco.es/cookies',
    bankTransferEnabled: false
  }
} as const

const productionConfiguration = {
  ...localConfiguration,
  appEnv: 'production',
  databaseUrl: 'postgres://neteco:runtime-test@database.invalid/neteco?sslmode=require',
  redisUrl: 'rediss://cache.invalid/0',
  paymentProvider: 'redsys',
  invoiceProvider: 'beply',
  carrierProvider: 'manual',
  emailProvider: 'smtp',
  legal: { ...localConfiguration.legal, reviewedAt: '2026-08-13' },
  media: { ...localConfiguration.media, storageDirectory: '/srv/neteco/media', clamavHost: 'clamav.invalid' },
  auth: {
    ...localConfiguration.auth,
    tokenPepper: 'production-runtime-test-token-pepper',
    encryptionKey: Buffer.alloc(32, 1).toString('base64')
  },
  redsys: {
    ...localConfiguration.redsys,
    environment: 'production',
    merchantCode: '123456789',
    secretKey: 'production-runtime-test-redsys-key'
  },
  beply: {
    ...localConfiguration.beply,
    token: 'production-runtime-test-beply-token',
    invoiceSeries: 'INV',
    correctiveSeries: 'CRN',
    taxCode0: 'VAT0',
    taxCode10: 'VAT10',
    taxCode21: 'VAT21',
    paymentCodeRedsys: 'CARD',
    paymentCodeBankTransfer: 'WIRE',
    companyId: 'NETECO'
  },
  public: { ...localConfiguration.public, appEnv: 'production', baseUrl: 'https://neteco.es' }
} as const

describe('runtime configuration', () => {
  it('allows only safe mocks outside production', () => {
    expect(validateRuntimeConfiguration(localConfiguration).appEnv).toBe('local')
  })

  it('fails closed when production providers or secrets are absent', () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...localConfiguration,
        appEnv: 'production',
        public: { ...localConfiguration.public, appEnv: 'production', baseUrl: 'https://neteco.es' }
      })
    ).toThrow()
  })

  it('requires encrypted production database, Redis and public transports', () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...localConfiguration,
        appEnv: 'production',
        databaseUrl: 'postgres://neteco:secret@database.invalid/neteco',
        redisUrl: 'redis://cache.invalid/0',
        public: { ...localConfiguration.public, appEnv: 'production', baseUrl: 'http://neteco.invalid' }
      })
    ).toThrow()
  })

  it('rejects the public Redsys sandbox merchant in production', () => {
    expect(validateRuntimeConfiguration(productionConfiguration).redsys.environment).toBe('production')
    expect(() =>
      validateRuntimeConfiguration({
        ...productionConfiguration,
        redsys: { ...productionConfiguration.redsys, merchantCode: '999008881' }
      })
    ).toThrow('Production Redsys credentials are required')
  })
})
