import { z } from 'zod'

const environmentSchema = z.enum(['local', 'test', 'preview', 'demo', 'staging', 'production'])
const providerSchema = z.enum(['mock', 'redsys'])
const invoiceProviderSchema = z.enum(['mock', 'beply'])
const carrierProviderSchema = z.enum(['mock', 'manual', 'own-delivery', 'carrier'])

export const runtimeConfigurationSchema = z
  .object({
    appEnv: environmentSchema,
    databaseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://')),
    redisUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://')),
    paymentProvider: providerSchema,
    invoiceProvider: invoiceProviderSchema,
    carrierProvider: carrierProviderSchema,
    emailProvider: z.enum(['log', 'smtp', 'api']),
    legal: z.object({
      termsVersion: z.string().min(1),
      privacyVersion: z.string().min(1),
      reviewedAt: z.string()
    }),
    media: z.object({
      storageDirectory: z.string(),
      clamavHost: z.string(),
      clamavPort: z.number().int().min(1).max(65535),
      maxBytes: z.number().int().min(1_000).max(25_000_000)
    }),
    auth: z.object({
      tokenPepper: z.string().min(24),
      encryptionKey: z.string().refine((value) => Buffer.from(value, 'base64').byteLength === 32),
      sessionDays: z.number().int().min(1).max(90)
    }),
    redsys: z.object({
      environment: z.enum(['sandbox', 'production']),
      merchantCode: z.string(),
      terminal: z.string().regex(/^\d{1,3}$/),
      secretKey: z.string(),
      currency: z.string().regex(/^\d{3}$/),
      merchantName: z.string().min(1).max(25)
    }),
    beply: z.object({
      baseUrl: z.string().url(),
      token: z.string(),
      invoiceSeries: z.string(),
      correctiveSeries: z.string(),
      taxCode0: z.string(),
      taxCode10: z.string(),
      taxCode21: z.string(),
      paymentCodeRedsys: z.string(),
      paymentCodeBankTransfer: z.string(),
      companyId: z.string()
    }),
    public: z.object({
      appEnv: environmentSchema,
      baseUrl: z.string().url(),
      appVersion: z.string().min(1),
      legalTermsUrl: z.string().url(),
      privacyUrl: z.string().url(),
      cookiesUrl: z.string().url()
    })
  })
  .superRefine((config, context) => {
    if (config.public.appEnv !== config.appEnv) {
      context.addIssue({
        code: 'custom',
        path: ['public', 'appEnv'],
        message: 'Public and private environments differ'
      })
    }
    if (config.appEnv !== 'production') return
    const database = new URL(config.databaseUrl)
    if (!['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') ?? '')) {
      context.addIssue({
        code: 'custom',
        path: ['databaseUrl'],
        message: 'Production PostgreSQL requires TLS through sslmode=require, verify-ca or verify-full'
      })
    }
    if (!config.redisUrl.startsWith('rediss://')) {
      context.addIssue({ code: 'custom', path: ['redisUrl'], message: 'Production Redis requires TLS (rediss)' })
    }
    if (!config.public.baseUrl.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['public', 'baseUrl'], message: 'Production base URL requires HTTPS' })
    }
    if (
      !config.public.legalTermsUrl.startsWith('https://') ||
      !config.public.privacyUrl.startsWith('https://') ||
      !config.public.cookiesUrl.startsWith('https://') ||
      !config.legal.reviewedAt ||
      Number.isNaN(Date.parse(config.legal.reviewedAt))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['legal'],
        message: 'Production requires reviewed, HTTPS legal documents and a review date'
      })
    }
    if (!config.media.storageDirectory.startsWith('/') || !config.media.clamavHost) {
      context.addIssue({
        code: 'custom',
        path: ['media'],
        message: 'Production requires durable media storage and a ClamAV scanner'
      })
    }
    if (config.emailProvider === 'log') {
      context.addIssue({ code: 'custom', path: ['emailProvider'], message: 'Production cannot log emails' })
    }
    if (config.paymentProvider !== 'redsys' || config.redsys.environment !== 'production') {
      context.addIssue({
        code: 'custom',
        path: ['paymentProvider'],
        message: 'Production requires Redsys production mode'
      })
    }
    if (!config.redsys.merchantCode || !config.redsys.secretKey) {
      context.addIssue({ code: 'custom', path: ['redsys'], message: 'Production Redsys credentials are required' })
    }
    if (
      config.invoiceProvider !== 'beply' ||
      !config.beply.token ||
      !config.beply.invoiceSeries ||
      !config.beply.correctiveSeries ||
      !config.beply.taxCode0 ||
      !config.beply.taxCode10 ||
      !config.beply.taxCode21 ||
      !config.beply.paymentCodeRedsys ||
      !config.beply.paymentCodeBankTransfer ||
      !config.beply.companyId
    ) {
      context.addIssue({ code: 'custom', path: ['beply'], message: 'Production requires configured Beply invoicing' })
    }
    if (config.carrierProvider === 'mock') {
      context.addIssue({ code: 'custom', path: ['carrierProvider'], message: 'Production cannot use the mock carrier' })
    }
    if (config.auth.tokenPepper.startsWith('local-only-') || /^A+=?$/.test(config.auth.encryptionKey)) {
      context.addIssue({ code: 'custom', path: ['auth'], message: 'Production authentication secrets are required' })
    }
  })

export type RuntimeConfiguration = z.infer<typeof runtimeConfigurationSchema>

export function validateRuntimeConfiguration(value: unknown) {
  return runtimeConfigurationSchema.parse(value)
}
