<script setup lang="ts">
/**
 * Insignia de estado con color semántico. `tone` se puede dar a mano o deducir de un
 * código de estado conocido (`status`), que además se traduce a un nombre legible.
 */
import { adminStatusLabel, adminStatusTone, type AdminTone } from '~/utils/adminLabels'

const props = defineProps<{ tone?: AdminTone; status?: string; plain?: boolean }>()
const tone = computed(() => props.tone ?? (props.status ? adminStatusTone(props.status) : 'neutral'))
</script>

<template>
  <span class="adm-badge" :class="[`adm-badge--${tone}`, plain && 'adm-badge--plain']">
    <slot>{{ status ? adminStatusLabel(status) : '' }}</slot>
  </span>
</template>
