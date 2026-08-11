<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const is404 = computed(() => props.error?.statusCode === 404)
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center bg-slate-50">
    <img src="/logo-figura.png" alt="NETECO" class="h-16 w-auto opacity-80" >
    <p class="text-6xl font-bold text-neteco-500">{{ error?.statusCode ?? 500 }}</p>
    <h1 class="text-xl font-semibold text-slate-800">
      {{ is404 ? 'No hemos encontrado esta página' : 'Ha ocurrido un error' }}
    </h1>
    <p class="text-slate-500 max-w-md">
      {{ is404 ? 'Puede que el producto o la página ya no exista. Echa un vistazo al catálogo.' : 'Ha ocurrido un error. Inténtalo de nuevo en unos segundos.' }}
    </p>
    <div class="flex gap-3">
      <UButton v-if="is404" size="lg" icon="i-lucide-layout-grid" @click="clearError({ redirect: '/catalogo' })">
        Ver el catálogo
      </UButton>
      <UButton size="lg" :variant="is404 ? 'soft' : 'solid'" icon="i-lucide-arrow-left" @click="clearError({ redirect: '/' })">
        Volver a la tienda
      </UButton>
    </div>
  </div>
</template>
