<script setup lang="ts">
import BrandCenterPanel from '~/components/BrandCenterPanel.vue'

const runtime = useRuntimeConfig()

useSeoMeta({
  title: 'Marca y certificados',
  description:
    'Logotipos autorizados de NETECO, normas de uso y certificados con su número, su entidad emisora y su documento.',
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
