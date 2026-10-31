<script setup lang="ts">
import DownloadableTemplatesPanel from '~/components/DownloadableTemplatesPanel.vue'

const runtime = useRuntimeConfig()

useSeoMeta({
  title: 'Biblioteca de Plantillas Descargables · Neteco',
  description:
    'Checklists de autocontrol, planes de limpieza APPCC y guías técnicas en formato indexable y PDF accesible.',
  robots: 'index, follow'
})

useHead(() => ({
  link: [{ rel: 'canonical', href: `${runtime.public.baseUrl}/plantillas` }]
}))
</script>

<template>
  <main>
    <DownloadableTemplatesPanel />
  </main>
</template>
