export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@pinia/nuxt', 'nuxt-auth-utils', '@nuxt/eslint', '@nuxt/image'],
  // imágenes responsivas: se guarda UNA master por foto y aquí se generan
  // los tamaños y el WebP automáticamente (estándar de rendimiento e-commerce)
  image: {
    quality: 80,
    screens: { xs: 320, sm: 640, md: 768, lg: 1024, xl: 1280 }
  },
  css: ['~/assets/css/main.css'],
  sourcemap: {
    server: true,
    client: true
  },
  nitro: {
    esbuild: { options: { target: 'es2022' } }
  },
  runtimeConfig: {
    appEnv: process.env.APP_ENV || 'local',
    databaseUrl: process.env.DATABASE_URL || 'postgres://neteco:neteco-local@localhost:56432/neteco',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:56379/0',
    paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
    invoiceProvider: process.env.INVOICE_PROVIDER || 'mock',
    carrierProvider: process.env.CARRIER_PROVIDER || 'mock',
    emailProvider: process.env.EMAIL_PROVIDER || 'log',
    bankTransfer: {
      enabled: process.env.BANK_TRANSFER_ENABLED === 'true',
      iban: process.env.BANK_TRANSFER_IBAN || '',
      beneficiary: process.env.BANK_TRANSFER_BENEFICIARY || ''
    },
    legal: {
      termsVersion: process.env.LEGAL_TERMS_VERSION || 'purchase-2026-08-12',
      privacyVersion: process.env.LEGAL_PRIVACY_VERSION || 'privacy-2026-08-12',
      reviewedAt: process.env.LEGAL_REVIEWED_AT || ''
    },
    media: {
      storageDirectory: process.env.MEDIA_STORAGE_DIRECTORY || '.data/media',
      clamavHost: process.env.CLAMAV_HOST || '',
      clamavPort: Number(process.env.CLAMAV_PORT || 3310),
      maxBytes: Number(process.env.MEDIA_MAX_BYTES || 15_000_000)
    },
    session: {
      name: 'neteco-session',
      password: process.env.NUXT_SESSION_PASSWORD || 'local-only-session-password-change-me-now',
      maxAge: Number(process.env.AUTH_SESSION_DAYS || 30) * 24 * 60 * 60,
      cookie: {
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.APP_ENV === 'production'
      }
    },
    auth: {
      tokenPepper: process.env.AUTH_TOKEN_PEPPER || 'local-only-token-pepper-change-me',
      encryptionKey: process.env.AUTH_ENCRYPTION_KEY || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      sessionDays: Number(process.env.AUTH_SESSION_DAYS || 30)
    },
    redsys: {
      environment: process.env.REDSYS_ENV || 'sandbox',
      merchantCode: process.env.REDSYS_MERCHANT_CODE || '',
      terminal: process.env.REDSYS_TERMINAL || '1',
      secretKey: process.env.REDSYS_SECRET_KEY || '',
      currency: process.env.REDSYS_CURRENCY || '978',
      merchantName: process.env.REDSYS_MERCHANT_NAME || 'NETECO'
    },
    beply: {
      baseUrl: process.env.BEPLY_BASE_URL || 'https://api.beply.es/v3',
      token: process.env.BEPLY_API_TOKEN || '',
      invoiceSeries: process.env.BEPLY_INVOICE_SERIES || '',
      correctiveSeries: process.env.BEPLY_CORRECTIVE_SERIES || '',
      taxCode0: process.env.BEPLY_TAX_CODE_0 || '',
      taxCode10: process.env.BEPLY_TAX_CODE_10 || '',
      taxCode21: process.env.BEPLY_TAX_CODE_21 || '',
      paymentCodeRedsys: process.env.BEPLY_PAYMENT_CODE_REDSYS || '',
      paymentCodeBankTransfer: process.env.BEPLY_PAYMENT_CODE_BANK_TRANSFER || '',
      companyId: process.env.BEPLY_COMPANY_ID || ''
    },
    public: {
      appEnv: process.env.APP_ENV || 'local',
      baseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
      appVersion: process.env.APP_VERSION || 'dev',
      priceDisplayMode: process.env.PRICE_DISPLAY_MODE || 'gross',
      legalTermsUrl: process.env.LEGAL_TERMS_URL || 'https://neteco.es/legal',
      privacyUrl: process.env.PRIVACY_URL || 'https://neteco.es/legal',
      cookiesUrl: process.env.COOKIES_URL || 'https://neteco.es/cookies',
      bankTransferEnabled: process.env.BANK_TRANSFER_ENABLED === 'true'
    }
  },
  routeRules: {
    '/': { swr: 300 },
    '/catalogo': { swr: 120 },
    '/categoria/**': { swr: 120 },
    '/producto/**': { swr: 120 },
    '/contenido/**': { swr: 300 },
    '/buscar': { swr: 30 },
    '/robots.txt': { swr: 3600 },
    '/sitemap.xml': { swr: 3600 },
    '/sitemaps/**': { swr: 3600 },
    '/feeds/**': { swr: 900 },
    '/carrito': {
      ssr: true,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' }
    },
    '/checkout': {
      ssr: true,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' }
    },
    '/cuenta/**': {
      ssr: true,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' }
    },
    '/pedido/**': {
      ssr: true,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' }
    },
    '/admin/**': {
      ssr: true,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' }
    },
    '/api/admin/**': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } },
    '/api/orders/**': { headers: { 'cache-control': 'private, no-store' } }
  },
  // la tienda es siempre clara: sin modo oscuro aunque el navegador lo prefiera
  ui: { colorMode: false },
  app: {
    head: {
      htmlAttrs: { lang: 'es' },
      titleTemplate: '%s · NETECO',
      link: [{ rel: 'icon', type: 'image/png', href: '/favicon.png' }],
      meta: [
        {
          name: 'description',
          content:
            'Tienda online de NETECO: productos de limpieza e higiene profesional, químicos, menaje y suministros para hostelería, comercio, industria y colectividades.'
        }
      ]
    }
  },
  // Las fuentes viajan en dependencias npm fijadas: el build no depende de CDNs externos.
  fonts: {
    provider: 'local',
    processCSSVariables: false
  },
  icon: {
    // el escaneo solo mira los .vue: los iconos referenciados desde utils/shop.ts
    // (badges y estados de pedido) necesitan la colección completa en el server
    // y una lista explícita en el bundle de cliente
    serverBundle: { collections: ['lucide'] },
    clientBundle: {
      scan: true,
      icons: [
        'lucide:leaf',
        'lucide:utensils',
        'lucide:flask-conical',
        'lucide:clock',
        'lucide:landmark',
        'lucide:circle-check',
        'lucide:package',
        'lucide:truck',
        'lucide:check-check',
        'lucide:circle-x'
      ]
    }
  }
})
