<script setup lang="ts">
definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: 'Mi cuenta' })

const { user, clear } = useUserSession()
const { data } = await useFetch<{ orders: any[] }>('/api/orders')

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  navigateTo('/')
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Hola, {{ (user as any)?.name }}</h1>
        <p class="mt-1 text-sm text-slate-500">
          {{ (user as any)?.email }}
          <template v-if="(user as any)?.company"> · {{ (user as any)?.company }}</template>
        </p>
      </div>
      <UButton color="neutral" variant="soft" icon="i-lucide-log-out" @click="logout">Cerrar sesión</UButton>
    </div>

    <h2 class="mt-8 text-lg font-bold text-slate-900">Mis pedidos</h2>

    <div v-if="data?.orders?.length" class="mt-4 space-y-3">
      <NuxtLink
        v-for="o in data.orders"
        :key="o.id"
        :to="`/pedido/${o.id}`"
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-md"
      >
        <div>
          <p class="font-semibold text-slate-800">{{ o.id }}</p>
          <p class="text-xs text-slate-400">{{ formatDate(o.createdAt) }} · {{ o.lines }} artículo{{ o.lines === 1 ? '' : 's' }}</p>
        </div>
        <div class="flex items-center gap-4">
          <UBadge
            :color="(ORDER_STATUS[o.status] ?? ORDER_STATUS.pendiente_pago!).color"
            :icon="(ORDER_STATUS[o.status] ?? ORDER_STATUS.pendiente_pago!).icon"
            variant="subtle"
          >
            {{ (ORDER_STATUS[o.status] ?? ORDER_STATUS.pendiente_pago!).label }}
          </UBadge>
          <p class="font-bold text-slate-900">{{ formatPrice(o.total) }}</p>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-slate-300" />
        </div>
      </NuxtLink>
    </div>

    <div v-else class="mt-4 rounded-2xl border border-dashed border-slate-300 py-14 text-center">
      <UIcon name="i-lucide-package-open" class="mx-auto size-12 text-slate-300" />
      <p class="mt-3 font-medium text-slate-600">Todavía no tienes pedidos</p>
      <p class="mt-1 text-sm text-slate-400">Cuando hagas tu primer pedido aparecerá aquí.</p>
      <UButton to="/catalogo" class="mt-5" icon="i-lucide-layout-grid">Empezar a comprar</UButton>
    </div>
  </div>
</template>
