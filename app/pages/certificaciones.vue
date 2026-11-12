<script setup lang="ts">
import BrandCenterPanel from '~/components/BrandCenterPanel.vue'

const runtime = useRuntimeConfig()

useSeoMeta({
  title: 'Certificados y registros',
  description:
    'Certificados y registros de NETECO y de sus productos, cada uno con su número, su entidad emisora y su documento.',
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
