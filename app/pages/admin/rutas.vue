<script setup lang="ts">
import { ref } from 'vue'
import AdminDeliveryRoutePlanner from '../../components/AdminDeliveryRoutePlanner.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Rutas de reparto · Admin', robots: 'noindex, nofollow, noarchive' })

const routeId = ref('route-active-1')
</script>

<template>
  <AdminPage>
    <AdminDeliveryRoutePlanner :route-id="routeId" />
  </AdminPage>
</template>
