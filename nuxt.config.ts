export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@pinia/nuxt', 'nuxt-auth-utils'],
  css: ['~/assets/css/main.css'],
  // la tienda es siempre clara: sin modo oscuro aunque el navegador lo prefiera
  ui: { colorMode: false },
  app: {
    head: {
      htmlAttrs: { lang: 'es' },
      titleTemplate: (title) => (title ? `${title} · NETECO` : 'NETECO · Suministros profesionales'),
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
  fonts: {
    families: [
      { name: 'Inter', provider: 'google', weights: [400, 500, 600, 700], global: true },
      { name: 'Archivo', provider: 'google', weights: [500, 600, 700, 800], global: true }
    ]
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
