<script setup lang="ts">
import AdminCaseStudyEditor from '~/components/AdminCaseStudyEditor.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Casos de Éxito de Clientes · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <main class="p-6">
    <AdminCaseStudyEditor />
  </main>
</template>
