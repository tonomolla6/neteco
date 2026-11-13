<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos en Borrador Sujetos a Aprobación · Admin' })
</script>

<template>
  <AdminPage>
    <div class="p-6">
      <AdminDraftOrdersPanel />
    </div>
  </AdminPage>
</template>
