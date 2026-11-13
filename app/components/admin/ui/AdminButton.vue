<script setup lang="ts">
/** Botón único del panel. `primary` para la acción principal de la pantalla (una por vista). */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'danger-soft' | 'ghost'
    size?: 'md' | 'sm'
    icon?: string
    to?: string
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit'
    /** Solo icono: obliga a dar un nombre accesible. */
    label?: string
  }>(),
  { variant: 'secondary', size: 'md', icon: undefined, to: undefined, type: 'button', label: undefined }
)
const NuxtLink = resolveComponent('NuxtLink')
const slots = useSlots()
const iconOnly = computed(() => !slots.default)
</script>

<template>
  <component
    :is="props.to ? NuxtLink : 'button'"
    :to="props.to"
    :type="props.to ? undefined : props.type"
    :disabled="props.to ? undefined : props.disabled || props.loading"
    :aria-label="iconOnly ? props.label : undefined"
    :title="iconOnly ? props.label : undefined"
    class="adm-btn"
    :class="[`adm-btn--${props.variant}`, props.size === 'sm' && 'adm-btn--sm', iconOnly && 'adm-btn--icon']"
  >
    <UIcon v-if="props.loading" name="i-lucide-loader-circle" class="size-4 animate-spin" />
    <UIcon v-else-if="props.icon" :name="props.icon" class="size-4 shrink-0" />
    <slot />
  </component>
</template>
