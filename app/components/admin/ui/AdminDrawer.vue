<script setup lang="ts">
/** Panel lateral para crear o editar sin perder el listado que hay detrás. */
defineProps<{ title: string; description?: string; wide?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ content: wide ? 'max-w-2xl' : 'max-w-lg', body: 'adm adm-body', footer: 'justify-end gap-2' }"
  >
    <template #body>
      <slot />
    </template>
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </USlideover>
</template>
