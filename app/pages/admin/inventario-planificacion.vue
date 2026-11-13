<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Reposición, escaneo y conteos · Admin' })
</script>

<template>
  <AdminPage>
    <div>
      <AdminInventoryPlanning />
    </div>
  </AdminPage>
</template>
