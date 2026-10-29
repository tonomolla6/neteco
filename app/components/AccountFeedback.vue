<script setup lang="ts">
/**
 * Avisos de resultado de las acciones del área de cliente.
 * `role="status"` / `role="alert"` para que un lector de pantalla los anuncie:
 * antes eran `UAlert` sin rol, así que un cambio de contraseña correcto no se
 * anunciaba a nadie que no estuviera mirando la pantalla.
 */
defineProps<{ notice?: string; error?: string }>()
</script>

<template>
  <div class="space-y-3 empty:hidden">
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-alert-circle" :title="error" />
  </div>
</template>
