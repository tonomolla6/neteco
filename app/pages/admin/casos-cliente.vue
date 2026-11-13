<script setup lang="ts">
import AdminCaseStudyEditor from '~/components/AdminCaseStudyEditor.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Casos de éxito · Admin', robots: 'noindex, nofollow' })
</script>

<template>
  <AdminPage>
    <AdminCaseStudyEditor />
  </AdminPage>
</template>
