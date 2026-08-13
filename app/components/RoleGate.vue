<script setup lang="ts">
const props = defineProps<{ role: string | null | undefined; allow: string[] }>()
const permitted = computed(() => !!props.role && props.allow.includes(props.role))
</script>

<template><slot v-if="permitted" /></template>
