<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import type { CategoryResponse } from '~~/shared/types/catalog'
import { useAdminNavigation } from '~/composables/useAdminNavigation'
import { useDialogFocus } from '~/composables/useDialogFocus'

/**
 * Cabecera de la tienda.
 *
 * Tres piezas hermanas, no una: la franja de contacto y los accesos rápidos móviles se
 * desplazan con la página y solo queda fija la barra con logo, buscador y carrito. En un
 * móvil, una cabecera fija de 190 px se comía un cuarto de la pantalla; así quedan unos 116.
 *
 * En móvil el buscador ocupa todo el ancho y tiene botón propio, y debajo hay una fila de
 * accesos que se desliza con el dedo (como en los grandes almacenes online). El menú lateral
 * se abre desde aquí o desde la barra inferior: comparten estado con `useState`.
 */
const cart = useCartStore()
const { terms: commercialTerms, email: contactEmail, phone: contactPhone } = useCommercialTerms()
const { loggedIn, user, clear } = useUserSession()
const adminNavigation = useAdminNavigation()
const panelEntry = computed(() =>
  adminNavigation.cloudflare.value ? adminNavigation.staffEntry.value : user.value?.role === 'admin'
)

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
// Una familia sin productos no se enseña: lleva a una página vacía.
const roots = computed(() => (catData.value?.roots ?? []).filter((root) => root.count > 0))
const stockedChildren = (root: CategoryResponse['roots'][number]) => root.children.filter((child) => child.count > 0)
/** Familias para la fila de accesos móvil: las de más surtido primero. */
const quickFamilies = computed(() =>
  roots.value
    .flatMap((root) => (root.children.length ? stockedChildren(root) : [root]))
    .sort((left, right) => right.count - left.count)
    .slice(0, 8)
)

// «Repetir último pedido»: solo con sesión y con al menos un pedido.
const { lastOrder } = await useLastOrder()
const reorderDialog = useTemplateRef<{ start: (orderId: string) => void }>('reorderDialog')
const LISTS_PATH = '/cuenta/listas'

const mobileOpen = useState('mobile-menu-open', () => false)
const accountOpen = ref(false)
const openRoot = ref<number | null>(null)

const menuBtn = ref<HTMLButtonElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)
const mobileDialog = ref<HTMLElement | null>(null)
useDialogFocus(mobileDialog, mobileOpen)

const route = useRoute()
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
    accountOpen.value = false
  }
)

const accountLinks = [
  { to: '/cuenta', label: 'Resumen', icon: 'i-lucide-layout-dashboard' },
  { to: '/cuenta/pedidos', label: 'Mis pedidos', icon: 'i-lucide-package' },
  { to: LISTS_PATH, label: 'Listas', icon: 'i-lucide-list-checks' },
  { to: '/cuenta/direcciones', label: 'Direcciones', icon: 'i-lucide-map-pin' },
  { to: '/cuenta/seguridad', label: 'Acceso y seguridad', icon: 'i-lucide-shield-check' }
]
const helpLinks = [
  { to: '/ayuda', label: 'Centro de ayuda', icon: 'i-lucide-life-buoy' },
  { to: '/envios', label: 'Envíos y reparto', icon: 'i-lucide-truck' },
  { to: '/formas-de-pago', label: 'Formas de pago', icon: 'i-lucide-credit-card' },
  { to: '/devoluciones', label: 'Devoluciones', icon: 'i-lucide-undo-2' },
  { to: '/contacto', label: 'Contacto', icon: 'i-lucide-message-circle' }
]
const firstName = computed(() => user.value?.name?.split(' ')[0] ?? '')

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  accountOpen.value = false
  mobileOpen.value = false
  // Navegación dura: cerrando sesión desde una ruta protegida, el middleware `auth`
  // redirigía a /login?redirect=… antes de que se ejecutara la vuelta a la home.
  await navigateTo('/', { replace: true, external: true })
}

function repeatLastOrder() {
  if (!lastOrder.value) return
  mobileOpen.value = false
  reorderDialog.value?.start(lastOrder.value.id)
}
</script>

<template>
  <!-- franja superior: contacto, reparto y conmutador de IVA. Se desplaza con la página. -->
  <div class="bg-neteco-950 text-white">
    <div class="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-1.5 text-[13px] sm:px-6">
      <div class="flex shrink-0 items-center gap-4">
        <a
          v-if="contactPhone"
          :href="contactPhone.href"
          class="flex items-center gap-1.5 hover:text-neteco-200"
          :aria-label="`Llamar al ${contactPhone.display}`"
        >
          <UIcon name="i-lucide-phone" class="size-3.5" />
          <span class="hidden min-[400px]:inline">{{ contactPhone.display }}</span>
        </a>
        <a
          :href="`mailto:${contactEmail}`"
          class="items-center gap-1.5 hover:text-neteco-200"
          :class="contactPhone ? 'hidden md:flex' : 'flex'"
        >
          <UIcon name="i-lucide-mail" class="size-3.5" /> {{ contactEmail }}
        </a>
      </div>
      <NuxtLink
        to="/envios"
        data-header-delivery
        class="hidden min-w-0 items-center gap-1.5 hover:text-neteco-200 sm:flex"
      >
        <UIcon name="i-lucide-truck" class="size-3.5 shrink-0" />
        <span class="truncate">
          <span class="lg:hidden">Reparto propio en la Vall d'Albaida</span>
          <span class="hidden lg:inline">Reparto propio en Ontinyent y la Vall d'Albaida</span
          ><template v-if="commercialTerms.ownDeliveryDays">: {{ commercialTerms.ownDeliveryDays }}</template>
        </span>
      </NuxtLink>
      <PriceModeToggle class="shrink-0" />
    </div>
  </div>

  <header class="sticky top-0 z-40 border-b border-[var(--border)] bg-white">
    <!-- barra principal -->
    <div class="mx-auto flex max-w-[1600px] items-center gap-2 px-2 py-2 sm:gap-5 sm:px-6 sm:py-3">
      <button
        ref="menuBtn"
        type="button"
        class="grid size-11 place-items-center rounded-[var(--radius-control)] text-[var(--text-strong)] hover:bg-[var(--surface-sunken)] lg:hidden"
        aria-label="Abrir menú"
        @click="mobileOpen = true"
      >
        <UIcon name="i-lucide-menu" class="block size-6" />
      </button>

      <NuxtLink to="/" aria-label="NETECO, ir al inicio" class="flex shrink-0 items-center gap-2">
        <img src="/logo-figura.svg" alt="" width="34" height="36" class="h-8 w-auto sm:h-9" />
        <img src="/logo-texto.svg" alt="NETECO" width="140" height="24" class="h-5 w-auto sm:h-6" />
      </NuxtLink>

      <div class="hidden flex-1 md:block">
        <SearchBox prominent />
      </div>

      <div class="ml-auto flex items-center gap-0.5 sm:gap-1">
        <!-- Los dos accesos de quien repone, siempre visibles en escritorio. En móvil viven en
             la fila de accesos y en el menú. -->
        <NuxtLink
          to="/pedido-rapido"
          data-header-quick-order
          class="hidden h-11 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-sm font-semibold text-[var(--text-strong)] hover:bg-[var(--surface-sunken)] lg:flex"
        >
          <UIcon name="i-lucide-list-plus" class="block size-5 text-[var(--text-muted)]" /> Pedido rápido
        </NuxtLink>
        <NuxtLink
          :to="LISTS_PATH"
          data-header-lists
          class="hidden h-11 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-sm font-semibold text-[var(--text-strong)] hover:bg-[var(--surface-sunken)] lg:flex"
        >
          <UIcon name="i-lucide-list-checks" class="block size-5 text-[var(--text-muted)]" /> Listas
        </NuxtLink>

        <!-- cuenta -->
        <div class="relative" @keydown.escape="accountOpen = false">
          <button
            type="button"
            aria-label="Mi cuenta"
            :aria-expanded="accountOpen"
            aria-haspopup="true"
            class="flex h-11 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[var(--text-strong)] hover:bg-[var(--surface-sunken)]"
            @click="accountOpen = !accountOpen"
          >
            <UIcon name="i-lucide-circle-user-round" class="block size-6" />
            <span class="hidden text-left text-[13px] leading-tight xl:block">
              <span class="block text-[var(--text-muted)]">{{ loggedIn ? `Hola, ${firstName}` : 'Hola' }}</span>
              <span class="block font-semibold">{{ loggedIn ? 'Mi cuenta' : 'Entra o regístrate' }}</span>
            </span>
            <UIcon name="i-lucide-chevron-down" class="hidden size-4 xl:block" />
          </button>

          <div v-if="accountOpen" class="fixed inset-0 z-40" @click="accountOpen = false" />
          <div
            v-if="accountOpen"
            class="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-white py-1 shadow-[var(--shadow-overlay)]"
          >
            <template v-if="loggedIn">
              <p class="border-b border-[var(--border)] px-4 py-2 text-[13px] text-[var(--text-muted)]">
                {{ user?.email }}
              </p>
              <NuxtLink
                v-if="panelEntry"
                to="/admin"
                class="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-neteco-700 hover:bg-neteco-50"
              >
                <UIcon name="i-lucide-settings-2" class="size-4" /> Panel de administración
              </NuxtLink>
              <NuxtLink
                v-for="link in accountLinks"
                :key="link.to"
                :to="link.to"
                class="flex items-center gap-2 px-4 py-2.5 text-sm text-[var(--text)] hover:bg-neteco-50"
              >
                <UIcon :name="link.icon" class="size-4 text-[var(--text-muted)]" /> {{ link.label }}
              </NuxtLink>
              <div class="my-1 border-t border-[var(--border)]" />
              <button
                type="button"
                class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-[var(--text)] hover:bg-neteco-50"
                @click="logout"
              >
                <UIcon name="i-lucide-log-out" class="size-4 text-[var(--text-muted)]" /> Cerrar sesión
              </button>
            </template>
            <div v-else class="p-3">
              <UButton to="/login" block size="lg">Iniciar sesión</UButton>
              <p class="mt-3 text-center text-[13px] text-[var(--text-muted)]">
                ¿Primera vez?
                <NuxtLink to="/registro" class="font-semibold text-[var(--link)] underline-offset-4 hover:underline"
                  >Crear cuenta</NuxtLink
                >
              </p>
            </div>
          </div>
        </div>

        <!-- carrito -->
        <NuxtLink
          to="/carrito"
          :aria-label="cart.count ? `Carrito, ${cart.count} artículos` : 'Carrito'"
          class="relative flex h-11 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[var(--text-strong)] hover:bg-[var(--surface-sunken)]"
        >
          <span class="relative">
            <UIcon name="i-lucide-shopping-cart" class="block size-6" />
            <ClientOnly>
              <span
                v-if="cart.count"
                aria-hidden="true"
                class="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-neteco-700 px-1 text-[11px] font-bold text-white"
              >
                {{ cart.count }}
              </span>
            </ClientOnly>
          </span>
          <span class="hidden text-sm font-semibold xl:inline">Carrito</span>
        </NuxtLink>
      </div>
    </div>

    <!-- buscador móvil: a todo el ancho y con su botón, al alcance del pulgar -->
    <div class="px-3 pb-2.5 md:hidden">
      <SearchBox prominent size="lg" />
    </div>

    <!-- navegación de categorías (escritorio) -->
    <nav aria-label="Familias" class="hidden border-t border-[var(--border)] lg:block">
      <div class="mx-auto flex max-w-[1600px] items-center gap-1 px-4 sm:px-6">
        <NuxtLink
          to="/catalogo"
          class="flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold text-[var(--text-strong)] hover:text-[var(--link)]"
        >
          <UIcon name="i-lucide-layout-grid" class="size-4" /> Todo el catálogo
        </NuxtLink>

        <div v-for="root in roots" :key="root.id" class="group relative">
          <NuxtLink
            :to="`/categoria/${root.slug}`"
            class="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-[var(--text)] hover:text-[var(--link)]"
          >
            {{ root.name }}
            <UIcon name="i-lucide-chevron-down" class="size-3.5 opacity-60" />
          </NuxtLink>
          <div
            class="invisible absolute left-0 top-full z-50 max-w-[92vw] rounded-b-[var(--radius-surface)] border border-t-0 border-[var(--border)] bg-white p-5 opacity-0 shadow-[var(--shadow-overlay)] transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            :class="stockedChildren(root).length > 8 ? 'w-[860px]' : 'w-[320px]'"
          >
            <!-- muchas familias: columnas temáticas; pocas: lista simple -->
            <div v-if="stockedChildren(root).length > 8" class="grid grid-cols-3 gap-x-8 gap-y-5">
              <div v-for="g in groupFamilies(stockedChildren(root))" :key="g.title">
                <p class="mb-1.5 text-[13px] font-semibold text-[var(--text-muted)]">
                  {{ g.title }}
                </p>
                <NuxtLink
                  v-for="child in g.items"
                  :key="child.id"
                  :to="`/categoria/${child.slug}`"
                  class="-mx-2 flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-1 text-sm text-[var(--text)] hover:bg-neteco-50 hover:text-neteco-700"
                >
                  <span class="min-w-0">{{ child.name }}</span>
                  <span class="tabular shrink-0 text-[13px] text-[var(--text-muted)]">{{ child.count }}</span>
                </NuxtLink>
              </div>
            </div>
            <div v-else>
              <NuxtLink
                v-for="child in stockedChildren(root)"
                :key="child.id"
                :to="`/categoria/${child.slug}`"
                class="-mx-2 flex items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-sm text-[var(--text)] hover:bg-neteco-50 hover:text-neteco-700"
              >
                <span class="min-w-0">{{ child.name }}</span>
                <span class="tabular shrink-0 text-[13px] text-[var(--text-muted)]">{{ child.count }}</span>
              </NuxtLink>
            </div>
            <NuxtLink
              :to="`/categoria/${root.slug}`"
              class="mt-4 block border-t border-[var(--border)] pt-3 text-sm font-semibold text-[var(--link)] hover:underline"
            >
              Ver todo en {{ root.name }}
            </NuxtLink>
          </div>
        </div>
        <!-- A la derecha del todo, separado de las familias: no es una categoría más. -->
        <div class="ml-auto flex items-center gap-1">
          <ClientOnly>
            <button
              v-if="lastOrder"
              type="button"
              data-header-reorder
              class="flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold text-neteco-700 hover:text-neteco-500"
              @click="reorderDialog?.start(lastOrder.id)"
            >
              <UIcon name="i-lucide-rotate-cw" class="size-4" /> Repetir último pedido
            </button>
          </ClientOnly>
          <NuxtLink
            to="/ayuda"
            data-header-help
            class="flex items-center gap-1.5 py-2.5 pl-3 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--link)]"
          >
            <UIcon name="i-lucide-life-buoy" class="size-4" /> Ayuda
          </NuxtLink>
        </div>
      </div>
    </nav>
    <ClientOnly><ReorderDialog v-if="lastOrder" ref="reorderDialog" /></ClientOnly>
  </header>

  <!-- accesos rápidos móviles: una fila que se desliza con el dedo, sin migas ni menús -->
  <nav aria-label="Accesos rápidos de la tienda" class="border-b border-[var(--border)] bg-white lg:hidden">
    <ul class="scrollbar-none flex overflow-x-auto px-2 text-[15px] font-medium text-[var(--text-strong)]">
      <li>
        <NuxtLink to="/catalogo" class="flex h-11 items-center whitespace-nowrap px-3 font-semibold">Catálogo</NuxtLink>
      </li>
      <li>
        <NuxtLink to="/pedido-rapido" class="flex h-11 items-center whitespace-nowrap px-3">Pedido rápido</NuxtLink>
      </li>
      <li>
        <NuxtLink :to="LISTS_PATH" class="flex h-11 items-center whitespace-nowrap px-3">Listas</NuxtLink>
      </li>
      <ClientOnly>
        <li v-if="lastOrder">
          <button type="button" class="flex h-11 items-center whitespace-nowrap px-3" @click="repeatLastOrder">
            Repetir pedido
          </button>
        </li>
      </ClientOnly>
      <li v-for="family in quickFamilies" :key="family.id">
        <NuxtLink
          :to="`/categoria/${family.slug}`"
          class="flex h-11 items-center whitespace-nowrap px-3 text-[var(--text)]"
        >
          {{ family.name }}
        </NuxtLink>
      </li>
    </ul>
  </nav>

  <!-- menú móvil -->
  <Teleport to="body">
    <div v-if="mobileOpen" class="fixed inset-0 z-50 lg:hidden" @keydown.escape="mobileOpen = false">
      <div class="absolute inset-0 bg-slate-900/50" @click="mobileOpen = false" />
      <div
        ref="mobileDialog"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-label="Menú de navegación"
        class="absolute inset-y-0 left-0 flex w-[22rem] max-w-[88vw] flex-col overflow-y-auto bg-white shadow-[var(--shadow-overlay)]"
      >
        <!-- saludo y cuenta, como primer bloque: es lo que más se busca en el menú -->
        <div class="flex items-start justify-between gap-3 bg-neteco-900 p-4 text-white">
          <div class="min-w-0">
            <p class="font-display text-lg font-bold text-white">
              {{ loggedIn ? `Hola, ${firstName}` : 'Hola' }}
            </p>
            <p v-if="loggedIn" class="truncate text-[13px] text-neteco-100">{{ user?.email }}</p>
            <div v-else class="mt-2 flex gap-2">
              <NuxtLink
                to="/login"
                class="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-white px-4 text-sm font-semibold text-neteco-900"
                >Iniciar sesión</NuxtLink
              >
              <NuxtLink
                to="/registro"
                class="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-white/50 px-4 text-sm font-semibold text-white"
                >Crear cuenta</NuxtLink
              >
            </div>
          </div>
          <button
            ref="closeBtn"
            type="button"
            class="grid size-11 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-white/10"
            aria-label="Cerrar"
            @click="mobileOpen = false"
          >
            <UIcon name="i-lucide-x" class="block size-6" />
          </button>
        </div>

        <nav class="flex-1 py-2">
          <p class="px-4 pb-1 pt-3 text-[13px] font-semibold text-[var(--text-muted)]">Comprar</p>
          <NuxtLink
            to="/catalogo"
            class="flex min-h-12 items-center gap-3 px-4 font-semibold text-[var(--text-strong)] hover:bg-neteco-50"
          >
            <UIcon name="i-lucide-layout-grid" class="size-5 text-[var(--text-muted)]" /> Todo el catálogo
          </NuxtLink>
          <NuxtLink
            to="/pedido-rapido"
            class="flex min-h-12 items-center gap-3 px-4 font-semibold text-[var(--text-strong)] hover:bg-neteco-50"
          >
            <UIcon name="i-lucide-list-plus" class="size-5 text-[var(--text-muted)]" /> Pedido rápido
          </NuxtLink>
          <NuxtLink
            :to="LISTS_PATH"
            class="flex min-h-12 items-center gap-3 px-4 font-semibold text-[var(--text-strong)] hover:bg-neteco-50"
          >
            <UIcon name="i-lucide-list-checks" class="size-5 text-[var(--text-muted)]" /> Listas
          </NuxtLink>
          <button
            v-if="lastOrder"
            type="button"
            class="flex min-h-12 w-full items-center gap-3 px-4 text-left font-semibold text-[var(--text-strong)] hover:bg-neteco-50"
            @click="repeatLastOrder"
          >
            <UIcon name="i-lucide-rotate-cw" class="size-5 text-[var(--text-muted)]" /> Repetir último pedido
          </button>

          <p
            class="mt-2 border-t border-[var(--border)] px-4 pb-1 pt-4 text-[13px] font-semibold text-[var(--text-muted)]"
          >
            Familias
          </p>
          <div v-for="root in roots" :key="root.id">
            <button
              type="button"
              class="flex min-h-12 w-full items-center justify-between px-4 text-left font-medium text-[var(--text-strong)] hover:bg-[var(--canvas)]"
              :aria-expanded="openRoot === root.id"
              @click="openRoot = openRoot === root.id ? null : root.id"
            >
              {{ root.name }}
              <UIcon
                name="i-lucide-chevron-down"
                class="size-5 text-[var(--text-muted)] transition-transform"
                :class="openRoot === root.id ? 'rotate-180' : ''"
              />
            </button>
            <div v-if="openRoot === root.id" class="bg-[var(--canvas)] py-1">
              <NuxtLink
                :to="`/categoria/${root.slug}`"
                class="flex min-h-11 items-center px-6 text-[15px] font-semibold text-[var(--link)]"
              >
                Ver todo ({{ root.count }})
              </NuxtLink>
              <NuxtLink
                v-for="child in stockedChildren(root)"
                :key="child.id"
                :to="`/categoria/${child.slug}`"
                class="flex min-h-11 items-center justify-between gap-2 px-6 text-[15px] text-[var(--text)] hover:bg-neteco-50"
              >
                <span class="min-w-0">{{ child.name }}</span>
                <span class="tabular shrink-0 text-[13px] text-[var(--text-muted)]">{{ child.count }}</span>
              </NuxtLink>
            </div>
          </div>

          <template v-if="loggedIn">
            <p
              class="mt-2 border-t border-[var(--border)] px-4 pb-1 pt-4 text-[13px] font-semibold text-[var(--text-muted)]"
            >
              Tu cuenta
            </p>
            <NuxtLink
              v-if="panelEntry"
              to="/admin"
              class="flex min-h-12 items-center gap-3 px-4 font-medium text-neteco-700 hover:bg-neteco-50"
            >
              <UIcon name="i-lucide-settings-2" class="size-5" /> Panel de administración
            </NuxtLink>
            <NuxtLink
              v-for="link in accountLinks.filter((entry) => entry.to !== LISTS_PATH)"
              :key="link.to"
              :to="link.to"
              class="flex min-h-12 items-center gap-3 px-4 text-[var(--text)] hover:bg-neteco-50"
            >
              <UIcon :name="link.icon" class="size-5 text-[var(--text-muted)]" /> {{ link.label }}
            </NuxtLink>
            <button
              type="button"
              class="flex min-h-12 w-full items-center gap-3 px-4 text-left text-[var(--text)] hover:bg-neteco-50"
              @click="logout"
            >
              <UIcon name="i-lucide-log-out" class="size-5 text-[var(--text-muted)]" /> Cerrar sesión
            </button>
          </template>

          <p
            class="mt-2 border-t border-[var(--border)] px-4 pb-1 pt-4 text-[13px] font-semibold text-[var(--text-muted)]"
          >
            Ayuda
          </p>
          <NuxtLink
            v-for="link in helpLinks"
            :key="link.to"
            :to="link.to"
            class="flex min-h-12 items-center gap-3 px-4 text-[var(--text)] hover:bg-neteco-50"
          >
            <UIcon :name="link.icon" class="size-5 text-[var(--text-muted)]" /> {{ link.label }}
          </NuxtLink>
        </nav>

        <div class="space-y-2 border-t border-[var(--border)] p-4">
          <UButton v-if="contactPhone" :to="contactPhone.href" icon="i-lucide-phone" block size="lg">
            Llamar al {{ contactPhone.display }}
          </UButton>
          <UButton
            :to="`mailto:${contactEmail}`"
            icon="i-lucide-mail"
            block
            size="lg"
            color="neutral"
            variant="outline"
          >
            {{ contactEmail }}
          </UButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>
