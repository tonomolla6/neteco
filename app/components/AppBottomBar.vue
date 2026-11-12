<script setup lang="ts">
import { useCartStore } from '~/stores/cart'

/**
 * Barra inferior en móvil: los cinco destinos que se usan con el pulgar, como en las apps
 * de las grandes tiendas. Inicio, pedido rápido, carrito con su contador, cuenta y el menú
 * completo (el mismo panel que abre la cabecera, por `useState`). No se pinta donde ya hay
 * una barra de compra fija (ficha, carrito), en el pago ni en el panel.
 */
const route = useRoute()
const cart = useCartStore()
const { loggedIn } = useUserSession()
const mobileOpen = useState('mobile-menu-open', () => false)

const items = computed(() => [
  { to: '/', label: 'Inicio', icon: 'i-lucide-house' },
  { to: '/pedido-rapido', label: 'Pedido rápido', icon: 'i-lucide-list-plus' },
  { to: '/carrito', label: 'Carrito', icon: 'i-lucide-shopping-cart', cart: true },
  loggedIn.value
    ? { to: '/cuenta', label: 'Cuenta', icon: 'i-lucide-circle-user-round' }
    : { to: '/login', label: 'Entrar', icon: 'i-lucide-circle-user-round' }
])
const visible = computed(() => appBottomBarVisible(route.path))
const current = (to: string) => (to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`))
</script>

<template>
  <nav
    v-if="visible"
    aria-label="Accesos rápidos"
    class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-overlay)] lg:hidden"
  >
    <NuxtLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      :aria-current="current(item.to) ? 'page' : undefined"
      class="relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[12px] font-medium leading-tight"
      :class="current(item.to) ? 'text-[var(--action)]' : 'text-[var(--text-muted)]'"
    >
      <span
        v-if="current(item.to)"
        aria-hidden="true"
        class="absolute inset-x-4 top-0 h-0.5 rounded-full bg-[var(--action)]"
      />
      <span class="relative">
        <UIcon :name="item.icon" class="block size-6" />
        <ClientOnly>
          <span
            v-if="item.cart && cart.count"
            class="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-neteco-700 px-1 text-[11px] font-bold text-white"
          >
            <span class="sr-only">, </span>{{ cart.count }}<span class="sr-only"> artículos</span>
          </span>
        </ClientOnly>
      </span>
      {{ item.label }}
    </NuxtLink>
    <button
      type="button"
      class="flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[12px] font-medium leading-tight text-[var(--text-muted)]"
      aria-haspopup="dialog"
      :aria-expanded="mobileOpen"
      @click="mobileOpen = true"
    >
      <UIcon name="i-lucide-menu" class="block size-6" />
      Menú
    </button>
  </nav>
</template>
