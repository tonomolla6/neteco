<script setup lang="ts">
/**
 * Lleva acciones a la cabecera de AdminPage desde un componente interior, para que la
 * acción principal de cada pantalla esté siempre arriba a la derecha.
 */
</script>

<template>
  <ClientOnly>
    <Teleport to="#adm-page-actions" defer>
      <slot />
    </Teleport>
  </ClientOnly>
</template>
