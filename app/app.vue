<script setup lang="ts">
// Antes había aquí un splash de marca a pantalla completa que cubría la página hasta
// la hidratación y se desvanecía en 0,5 s. El coste era mayor que el problema que
// resolvía: la página ya viene renderizada del servidor y era legible, así que el
// splash la tapaba, convertía el logotipo en el elemento LCP y obligaba al operario
// del panel a mirarlo veinte veces al día.
//
// Se mantiene `NuxtLoadingIndicator` para las navegaciones y se deja que el contenido
// del servidor se vea desde el primer momento. Los clics muertos durante la hidratación
// se evitan en cada componente con estados `disabled`/`loading`, no ocultando la página.
const route = useRoute()
const runtime = useRuntimeConfig()
const demo = computed(() => runtime.public.demoEnabled === true && runtime.public.serverRuntime === 'cloudflare')
const origin = String(runtime.public.baseUrl).replace(/\/$/, '')
const canonicalUrl = computed(() => `${origin}${canonicalPath(route.path, route.query)}`)
useHead(() => ({
  link:
    canonicalPath(route.path, {}) === '/buscar'
      ? []
      : [
          { rel: 'canonical', href: canonicalUrl.value },
          { rel: 'alternate', hreflang: 'es-ES', href: canonicalUrl.value },
          { rel: 'alternate', hreflang: 'x-default', href: canonicalUrl.value }
        ],
  script: [
    {
      key: 'organization-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'NETECO',
        url: origin,
        logo: `${origin}/logo-figura.png`,
        contactPoint: {
          '@type': 'ContactPoint',
          telephone: '+34 600 861 334',
          contactType: 'customer service',
          availableLanguage: ['es']
        }
      })
    }
  ]
}))
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <div v-if="demo" role="note" class="bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-950">
      DEMO pública compartida · No introduzcas datos personales reales · Sin cobros, facturación ni correos reales
    </div>
    <NuxtLoadingIndicator color="#009ac9" :height="3" />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
