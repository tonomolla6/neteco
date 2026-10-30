<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos en Borrador Sujetos a Aprobación · Admin' })
</script>

<template>
  <div class="p-6">
    <AdminDraftOrdersPanel />
  </div>
</template>
