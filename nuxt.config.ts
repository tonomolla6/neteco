import { fileURLToPath } from 'node:url'

const cloudflareRuntime = process.env.NETECO_RUNTIME === 'cloudflare'
const cloudflareServerDir = fileURLToPath(new URL('./server-cloudflare/', import.meta.url))
const cloudflareOutputDir = fileURLToPath(new URL('./.output-cloudflare/', import.meta.url))

export default defineNuxtConfig({
  ...(cloudflareRuntime ? { buildDir: '.nuxt-cloudflare', serverDir: cloudflareServerDir, ssr: true } : {}),
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@pinia/nuxt', 'nuxt-auth-utils', '@nuxt/eslint', '@nuxt/image'],
  // imágenes responsivas: se guarda UNA master por foto y aquí se generan
  // los tamaños y el WebP automáticamente (estándar de rendimiento e-commerce)
  image: {
    // No IPX/Sharp or filesystem image transformations in the Workers isolate.
    ...(cloudflareRuntime ? { provider: 'none' } : {}),
    quality: 80,
    screens: { xs: 320, sm: 640, md: 768, lg: 1024, xl: 1280 }
  },
  css: ['~/assets/css/main.css'],
  sourcemap: {
    server: true,
    client: true
  },
  nitro: {
    ...(cloudflareRuntime
      ? {
          preset: 'cloudflare-module',
          srcDir: cloudflareServerDir,
          scanDirs: [cloudflareServerDir],
          output: { dir: cloudflareOutputDir },
          cloudflare: { deployConfig: false, nodeCompat: true },
          prerender: { crawlLinks: false, routes: [] }
        }
      : {}),
    esbuild: { options: { target: 'es2022' } }
  },
  hooks: {
    'nitro:config'(config) {
      if (!cloudflareRuntime) return
      // Modules still provide client composables, but never a second session
      // authority or a scanner capable of importing legacy PostgreSQL routes.
      config.srcDir = cloudflareServerDir
      config.scanDirs = [cloudflareServerDir]
      config.handlers = config.handlers?.filter((handler) => handler && handler.route !== '/api/_auth/session')
      // Nuxt merges page/module rules late. Remove every cache variant here too:
      // HTML may contain a customer's session, so it is not public SWR data.
      for (const rule of Object.values(config.routeRules ?? {})) {
        delete rule.swr
        delete rule.isr
        rule.cache = false
      }
      config.routeRules = {
        ...config.routeRules,
        '/**': {
          ...config.routeRules?.['/**'],
          cache: false,
          headers: { ...config.routeRules?.['/**']?.headers, 'cache-control': 'private, no-store' }
        }
      }
    }
  },
  runtimeConfig: {
    appEnv: process.env.APP_ENV || 'local',
    cspMode: process.env.CSP_MODE || 'report-only',
    databaseUrl: cloudflareRuntime
      ? ''
      : process.env.DATABASE_URL || 'postgres://neteco:neteco-local@localhost:56432/neteco',
    redisUrl: cloudflareRuntime ? '' : process.env.REDIS_URL || 'redis://localhost:56379/0',
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
      password: cloudflareRuntime
        ? ''
        : process.env.NUXT_SESSION_PASSWORD || 'local-only-session-password-change-me-now',
      maxAge: Number(process.env.AUTH_SESSION_DAYS || 30) * 24 * 60 * 60,
      cookie: {
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.APP_ENV === 'production'
      }
    },
    auth: {
      tokenPepper: cloudflareRuntime ? '' : process.env.AUTH_TOKEN_PEPPER || 'local-only-token-pepper-change-me',
      encryptionKey: cloudflareRuntime
        ? ''
        : process.env.AUTH_ENCRYPTION_KEY || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      sessionDays: Number(process.env.AUTH_SESSION_DAYS || 30)
    },
    redsys: {
      environment: process.env.REDSYS_ENV || 'sandbox',
      merchantCode: process.env.REDSYS_MERCHANT_CODE || '',
      terminal: process.env.REDSYS_TERMINAL || '1',
      secretKey: cloudflareRuntime ? '' : process.env.REDSYS_SECRET_KEY || '',
      currency: process.env.REDSYS_CURRENCY || '978',
      merchantName: process.env.REDSYS_MERCHANT_NAME || 'NETECO'
    },
    beply: {
      baseUrl: process.env.BEPLY_BASE_URL || 'https://api.beply.es/v3',
      token: cloudflareRuntime ? '' : process.env.BEPLY_API_TOKEN || '',
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
      cspMode: process.env.CSP_MODE || 'report-only',
      // Opt-in only for the isolated public demo; backend authority is separate.
      demoEnabled: false,
      // Legacy demo photos are not evidence of publication rights or scanning.
      mediaGoverned: cloudflareRuntime,
      serverRuntime: cloudflareRuntime ? 'cloudflare' : 'node',
      // NUXT_PUBLIC_* is the runtime override used by the built Nitro image.
      // APP_BASE_URL remains the shared origin for workers and build-time configuration.
      baseUrl: process.env.NUXT_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000',
      appVersion: process.env.APP_VERSION || 'dev',
      priceDisplayMode: process.env.PRICE_DISPLAY_MODE || 'gross',
      legalTermsUrl: process.env.LEGAL_TERMS_URL || 'https://neteco.es/legal',
      privacyUrl: process.env.PRIVACY_URL || 'https://neteco.es/legal',
      cookiesUrl: process.env.COOKIES_URL || 'https://neteco.es/cookies',
      bankTransferEnabled: process.env.BANK_TRANSFER_ENABLED === 'true',
      // Mismo origen y mismo criterio que `shippingCommercialPolicy()` en el servidor,
      // que sigue siendo la autoridad: aquí solo se expone para que la tienda pueda
      // decir cuánto falta para el envío gratis en vez de llevar «150 €» escrito a
      // mano en la copia. Sin umbral (producción sin configurar) vale 0 y no se enseña.
      freeShippingThresholdCents: Number(
        process.env.FREE_SHIPPING_THRESHOLD_CENTS?.trim() || (process.env.APP_ENV === 'production' ? 0 : 15_000)
      ),
      // Secciones de contenido publicadas (`shared/published-sections.ts`). Vacío: ninguna.
      publishedSections: process.env.PUBLISHED_SECTIONS || '',
      // Condiciones comerciales que decide el negocio (`shared/commercial-terms.ts`). Todas
      // vacías por defecto: la tienda solo escribe una promesa con cifra si el dato está aquí.
      // El umbral de envío gratis no se duplica: sale de `freeShippingThresholdCents`.
      commercial: {
        ownDeliveryDays: process.env.COMMERCIAL_OWN_DELIVERY_DAYS || '',
        orderCutoffTime: process.env.COMMERCIAL_ORDER_CUTOFF_TIME || '',
        ownDeliveryCostCents: process.env.COMMERCIAL_OWN_DELIVERY_COST_CENTS || '',
        ownDeliveryFreeFromCents: process.env.COMMERCIAL_OWN_DELIVERY_FREE_FROM_CENTS || '',
        ownDeliveryMinimumOrderCents: process.env.COMMERCIAL_OWN_DELIVERY_MINIMUM_ORDER_CENTS || '',
        parcelLeadTime: process.env.COMMERCIAL_PARCEL_LEAD_TIME || '',
        parcelCostCents: process.env.COMMERCIAL_PARCEL_COST_CENTS || '',
        deferredPaymentDays: process.env.COMMERCIAL_DEFERRED_PAYMENT_DAYS || '',
        deferredPaymentConditions: process.env.COMMERCIAL_DEFERRED_PAYMENT_CONDITIONS || '',
        supportHours: process.env.COMMERCIAL_SUPPORT_HOURS || '',
        whatsappNumber: process.env.COMMERCIAL_WHATSAPP_NUMBER || '',
        foundedYear: process.env.COMMERCIAL_FOUNDED_YEAR || '',
        ecoRangeBrand: process.env.COMMERCIAL_ECO_RANGE_BRAND || '',
        companyTaxId: process.env.COMMERCIAL_COMPANY_TAX_ID || '',
        companyAddress: process.env.COMMERCIAL_COMPANY_ADDRESS || '',
        certificationsPublished: process.env.COMMERCIAL_CERTIFICATIONS_PUBLISHED || ''
      }
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
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
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
    ...(cloudflareRuntime ? { localApiEndpoint: '/_icons' } : {}),
    // El escaneo no incluye registros .ts: estados y navegación administrativa
    // necesitan SVGs explícitos en cliente, sin depender de otras páginas .vue.
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
        'lucide:layout-dashboard',
        'lucide:receipt-text',
        'lucide:building-2',
        'lucide:contact-round',
        'lucide:file-check-2',
        'lucide:rotate-ccw',
        'lucide:life-buoy',
        'lucide:message-square',
        'lucide:warehouse',
        'lucide:folder-tree',
        'lucide:shield-check',
        'lucide:badge-euro',
        'lucide:images',
        'lucide:panels-top-left',
        'lucide:mails',
        'lucide:chart-no-axes-combined',
        'lucide:history',
        'lucide:activity',
        'lucide:search-check',
        'lucide:ticket-percent',
        'lucide:truck',
        'lucide:check-check',
        'lucide:circle-x',
        'lucide:arrow-up-down',
        'lucide:award',
        'lucide:badge-percent',
        'lucide:bell-ring',
        'lucide:book-check',
        'lucide:boxes',
        'lucide:calendar-days',
        'lucide:calendar-range',
        'lucide:camera',
        'lucide:clipboard-check',
        'lucide:clipboard-list',
        'lucide:compass',
        'lucide:credit-card',
        'lucide:diff',
        'lucide:file-clock',
        'lucide:file-search',
        'lucide:file-text',
        'lucide:gauge',
        'lucide:globe',
        'lucide:graduation-cap',
        'lucide:layout-grid',
        'lucide:list-checks',
        'lucide:map-pin',
        'lucide:megaphone',
        'lucide:messages-square',
        'lucide:package-check',
        'lucide:plug',
        'lucide:rocket',
        'lucide:scan-barcode',
        'lucide:send',
        'lucide:shield-alert',
        'lucide:sliders-horizontal',
        'lucide:smartphone',
        'lucide:sparkles',
        'lucide:target',
        'lucide:trending-up',
        'lucide:triangle-alert',
        'lucide:user-check',
        'lucide:user-cog',
        'lucide:user-plus',
        'lucide:users',
        'lucide:video',
        'lucide:webhook',
        'lucide:workflow',
        'lucide:clipboard-pen',
        'lucide:message-square-more',
        'lucide:percent',
        'lucide:search-x'
      ]
    }
  }
})
