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
    legalTermsUrl: 'https://neteco.es/legal',
    privacyUrl: 'https://neteco.es/legal',
    cookiesUrl: 'https://neteco.es/cookies'
  }
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
})
