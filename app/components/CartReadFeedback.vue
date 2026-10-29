<script setup lang="ts">
defineProps<{ loading: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" role="status" aria-live="polite" aria-busy="true" class="mt-6 py-8 text-center">
    Consultando el carrito…
  </div>
  <div v-else role="alert" class="mt-6 rounded-xl border border-red-200 bg-red-50 p-5">
    <p>No hemos podido consultar el carrito. Tus productos no se han confirmado todavía.</p>
    <UButton type="button" color="neutral" variant="outline" class="mt-3" @click="$emit('retry')">
      Reintentar consulta
    </UButton>
  </div>
</template>
