<script setup lang="ts">
/** Confirmación en modal para acciones con consecuencias. Nunca `window.confirm`. */
withDefaults(
  defineProps<{
    title: string
    description?: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
    loading?: boolean
    /** Desactiva el botón de confirmar (p. ej. mientras falta un motivo obligatorio). */
    confirmDisabled?: boolean
  }>(),
  {
    description: undefined,
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar',
    danger: false,
    loading: false,
    confirmDisabled: false
  }
)
const open = defineModel<boolean>('open', { required: true })
defineEmits<{ confirm: [] }>()
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ footer: 'justify-end gap-2' }">
    <template v-if="$slots.default" #body>
      <div class="adm">
        <slot />
      </div>
    </template>
    <template #footer>
      <AdminButton @click="open = false">{{ cancelLabel }}</AdminButton>
      <AdminButton
        :variant="danger ? 'danger' : 'primary'"
        :loading="loading"
        :disabled="confirmDisabled"
        @click="$emit('confirm')"
      >
        {{ confirmLabel }}
      </AdminButton>
    </template>
  </UModal>
</template>
