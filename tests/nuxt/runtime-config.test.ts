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
    taxCode21: '',
    paymentCodeRedsys: '',
    companyId: ''
  },
  public: { appEnv: 'local', baseUrl: 'http://localhost:3000', appVersion: 'test' }
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
})
