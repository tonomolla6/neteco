<script setup lang="ts">
import { ref } from 'vue'
import AdminDeliveryRoutePlanner from '../../components/AdminDeliveryRoutePlanner.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Planificación de Rutas Propias · Admin', robots: 'noindex, nofollow, noarchive' })

const routeId = ref('route-active-1')
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-slate-900">Rutas y Reparto Propio</h1>
    </div>

    <AdminDeliveryRoutePlanner :route-id="routeId" />
  </div>
</template>
