<script setup lang="ts">
import BrandCenterPanel from '~/components/BrandCenterPanel.vue'

const runtime = useRuntimeConfig()

useSeoMeta({
  title: 'Certificaciones Oficiales y Acreditaciones · Neteco',
  description:
    'Auditoría y consulta pública de certificaciones ISO 9001, ISO 14001, EU Ecolabel y registros oficiales. Cero sellos vagos.',
  robots: 'index, follow'
})

useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/certificaciones` }]
}))
</script>

<template>
  <main>
    <BrandCenterPanel />
  </main>
</template>
