<script setup lang="ts">
import BrandCenterPanel from '~/components/BrandCenterPanel.vue'

const runtime = useRuntimeConfig()

useSeoMeta({
  title: 'Centro de Marca y Certificaciones Oficiales · Neteco',
  description:
    'Logotipos autorizados, normativas de uso y registro oficial de certificaciones ISO, EU Ecolabel y registros sanitarios sin sellos vagos.',
  robots: 'index, follow'
})

useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/marca` }]
}))
</script>

<template>
  <main>
    <BrandCenterPanel />
  </main>
</template>
