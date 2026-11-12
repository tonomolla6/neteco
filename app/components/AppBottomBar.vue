<script setup lang="ts">
/**
 * Barra inferior en móvil: los cuatro destinos de quien repone, a un toque y con el pulgar.
 * El carrito sigue en la cabecera con su contador. No se pinta donde ya hay una barra de
 * compra fija (ficha, carrito), en el pago ni en el panel.
 */
const route = useRoute()
const LISTS_PATH = '/cuenta/listas'
const items = [
  { to: '/', label: 'Inicio', icon: 'i-lucide-house' },
  { to: '/buscar', label: 'Buscar', icon: 'i-lucide-search' },
  { to: '/pedido-rapido', label: 'Pedido rápido', icon: 'i-lucide-list-plus' },
  { to: LISTS_PATH, label: 'Listas', icon: 'i-lucide-list-checks' }
]
const visible = computed(() => appBottomBarVisible(route.path))
const current = (to: string) => (to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`))
</script>

<template>
  <nav
    v-if="visible"
    aria-label="Accesos rápidos"
    class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-overlay)] lg:hidden"
  >
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      :aria-current="current(item.to) ? 'page' : undefined"
      class="flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[13px] font-medium leading-tight"
      :class="current(item.to) ? 'text-[var(--action)]' : 'text-[var(--text-muted)]'"
    >
      <UIcon :name="item.icon" class="size-5" />{{ item.label }}
    </NuxtLink>
  </nav>
</template>
