<script setup lang="ts">
import AdminModelEvaluationGate from '../../components/AdminModelEvaluationGate.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({
  title: 'Evaluación de modelos de IA · Admin',
  robots: 'noindex, nofollow, noarchive'
})
</script>

<template>
  <AdminPage>
    <AdminModelEvaluationGate />
  </AdminPage>
</template>
