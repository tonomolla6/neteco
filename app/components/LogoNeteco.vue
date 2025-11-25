<script setup lang="ts">
defineProps<{
  size?: 'sm' | 'md' | 'lg'
  variant?: 'full' | 'icon' | 'text'
}>()
</script>

<template>
  <div
    class="flex flex-col items-center"
    :class="{
      'w-12': size === 'sm',
      'w-20': size === 'md',
      'w-32': size === 'lg' || !size
    }"
  >
    <!-- Icono (figura) -->
    <img
      v-if="variant === 'full' || variant === 'icon' || !variant"
      src="/logo-figura.png"
      alt="NETECO"
      class="w-full h-auto"
    />
    <!-- Texto -->
    <img
      v-if="variant === 'full' || variant === 'text' || !variant"
      src="/logo-texto.png"
      alt="NETECO"
      class="h-auto"
      :class="{
        'w-full mt-1': variant === 'full' || !variant,
        'w-full': variant === 'text'
      }"
    />
  </div>
</template>
