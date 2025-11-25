<script setup lang="ts">
defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>()
</script>

<template>
  <div
    class="flex flex-col items-center"
    :class="{
      'w-16': size === 'sm',
      'w-24': size === 'md',
      'w-32': size === 'lg' || !size
    }"
  >
    <img
      src="/logo-figura.png"
      alt="NETECO"
      class="w-full h-auto"
    />
    <img
      src="/logo-texto.png"
      alt="NETECO"
      class="w-full h-auto mt-1"
    />
  </div>
</template>
