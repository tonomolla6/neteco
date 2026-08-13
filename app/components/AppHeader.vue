<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import type { CategoryResponse } from '~~/shared/types/catalog'

const cart = useCartStore()
const { loggedIn, user, clear } = useUserSession()

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
const roots = computed(() => catData.value?.roots ?? [])

const mobileOpen = ref(false)
const accountOpen = ref(false)
const openRoot = ref<number | null>(null)

const menuBtn = ref<HTMLButtonElement | null>(null)
const closeBtn = ref<HTMLButtonElement | null>(null)
watch(mobileOpen, (v) => {
  if (v) nextTick(() => closeBtn.value?.focus())
  else menuBtn.value?.focus()
})

const route = useRoute()
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
    accountOpen.value = false
  }
)

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  accountOpen.value = false
  navigateTo('/')
}
</script>

<template>
  <header class="sticky top-0 z-40 bg-white shadow-sm">
    <!-- franja superior -->
    <div class="bg-neteco-800 text-white">
      <div class="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-1.5 text-xs">
        <div class="flex items-center gap-4">
          <a href="tel:600861334" class="flex items-center gap-1.5 hover:text-neteco-200">
            <UIcon name="i-lucide-phone" class="size-3.5" /> 600 861 334
          </a>
          <a href="mailto:administracion@neteco.es" class="hidden items-center gap-1.5 hover:text-neteco-200 sm:flex">
            <UIcon name="i-lucide-mail" class="size-3.5" /> administracion@neteco.es
          </a>
        </div>
        <div class="hidden items-center gap-4 md:flex">
          <NuxtLink to="/envios" class="flex items-center gap-1.5 hover:text-neteco-200">
            <UIcon name="i-lucide-truck" class="size-3.5" />
            Reparto propio en Ontinyent y la Vall d'Albaida
          </NuxtLink>
          <NuxtLink to="/envios" class="flex items-center gap-1.5 hover:text-neteco-200">
            <UIcon name="i-lucide-badge-euro" class="size-3.5" />
            Coste y fecha calculados por destino
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- barra principal -->
    <div class="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:gap-6">
      <button
        ref="menuBtn"
        class="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
        aria-label="Abrir menú"
        @click="mobileOpen = true"
      >
        <UIcon name="i-lucide-menu" class="block size-6" />
      </button>

      <NuxtLink to="/" aria-label="NETECO, ir al inicio" class="flex shrink-0 items-center gap-2">
        <img src="/logo-figura.png" alt="" class="h-9 w-auto" />
        <img src="/logo-texto.png" alt="NETECO" class="hidden h-6 w-auto sm:block" />
      </NuxtLink>

      <div class="hidden flex-1 md:block">
        <SearchBox />
      </div>

      <div class="ml-auto flex items-center gap-1 sm:gap-2">
        <!-- cuenta -->
        <div class="relative" @keydown.escape="accountOpen = false">
          <button
            aria-label="Mi cuenta"
            :aria-expanded="accountOpen"
            aria-haspopup="true"
            class="flex items-center gap-2 rounded-lg p-2 text-slate-600 hover:bg-slate-100"
            @click="accountOpen = !accountOpen"
          >
            <UIcon name="i-lucide-circle-user-round" class="block size-6" />
            <span class="hidden text-sm font-medium xl:block">
              {{ loggedIn ? user?.name?.split(' ')[0] : 'Mi cuenta' }}
            </span>
            <UIcon name="i-lucide-chevron-down" class="hidden size-4 xl:block" />
          </button>

          <div v-if="accountOpen" class="fixed inset-0 z-40" @click="accountOpen = false" />
          <div
            v-if="accountOpen"
            class="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl"
          >
            <template v-if="loggedIn">
              <p class="border-b border-slate-100 px-4 py-2 text-xs text-slate-400">
                {{ user?.email }}
              </p>
              <RoleGate :role="user?.role" :allow="['admin']">
                <NuxtLink
                  to="/admin"
                  class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neteco-700 hover:bg-neteco-50"
                >
                  <UIcon name="i-lucide-settings-2" class="size-4" /> Panel de administración
                </NuxtLink>
              </RoleGate>
              <NuxtLink
                to="/cuenta"
                class="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-neteco-50"
              >
                <UIcon name="i-lucide-package" class="size-4" /> Mis pedidos
              </NuxtLink>
              <button
                class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-neteco-50"
                @click="logout"
              >
                <UIcon name="i-lucide-log-out" class="size-4" /> Cerrar sesión
              </button>
            </template>
            <template v-else>
              <NuxtLink to="/login" class="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-neteco-50">
                <UIcon name="i-lucide-log-in" class="size-4" /> Iniciar sesión
              </NuxtLink>
              <NuxtLink
                to="/registro"
                class="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-neteco-50"
              >
                <UIcon name="i-lucide-user-plus" class="size-4" /> Crear cuenta
              </NuxtLink>
            </template>
          </div>
        </div>

        <!-- carrito -->
        <NuxtLink
          to="/carrito"
          :aria-label="cart.count ? `Carrito, ${cart.count} artículos` : 'Carrito'"
          class="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
        >
          <UIcon name="i-lucide-shopping-cart" class="block size-6" />
          <ClientOnly>
            <span
              v-if="cart.count"
              aria-hidden="true"
              class="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-neteco-600 px-1 text-[11px] font-bold text-white"
            >
              {{ cart.count }}
            </span>
          </ClientOnly>
        </NuxtLink>
      </div>
    </div>

    <!-- buscador móvil -->
    <div class="border-t border-slate-100 px-4 py-2 md:hidden">
      <SearchBox size="sm" />
    </div>

    <!-- navegación de categorías (escritorio) -->
    <nav class="hidden border-t border-slate-100 lg:block">
      <div class="mx-auto flex max-w-[1600px] items-center gap-1 px-4">
        <NuxtLink
          to="/catalogo"
          class="flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold text-neteco-700 hover:text-neteco-500"
        >
          <UIcon name="i-lucide-layout-grid" class="size-4" /> Todo el catálogo
        </NuxtLink>

        <div v-for="root in roots" :key="root.id" class="group relative">
          <NuxtLink
            :to="`/categoria/${root.slug}`"
            class="flex items-center gap-1 px-3 py-2.5 text-sm font-medium text-slate-600 hover:text-neteco-600"
          >
            {{ root.name }}
            <UIcon name="i-lucide-chevron-down" class="size-3.5 opacity-60" />
          </NuxtLink>
          <div
            class="invisible absolute left-0 top-full z-50 max-w-[92vw] rounded-b-xl border border-t-0 border-slate-200 bg-white p-5 opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            :class="root.children.filter((category) => category.count > 0).length > 8 ? 'w-[860px]' : 'w-[320px]'"
          >
            <!-- muchas familias: columnas temáticas; pocas: lista simple -->
            <div
              v-if="root.children.filter((category) => category.count > 0).length > 8"
              class="grid grid-cols-3 gap-x-8 gap-y-5"
            >
              <div v-for="g in groupFamilies(root.children.filter((category) => category.count > 0))" :key="g.title">
                <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {{ g.title }}
                </p>
                <NuxtLink
                  v-for="child in g.items"
                  :key="child.id"
                  :to="`/categoria/${child.slug}`"
                  class="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-sm text-slate-700 hover:bg-neteco-50 hover:text-neteco-700"
                >
                  <span class="min-w-0">{{ child.name }}</span>
                  <span class="shrink-0 text-xs tabular-nums text-slate-400">{{ child.count }}</span>
                </NuxtLink>
              </div>
            </div>
            <div v-else>
              <NuxtLink
                v-for="child in root.children.filter((category) => category.count > 0)"
                :key="child.id"
                :to="`/categoria/${child.slug}`"
                class="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-neteco-50 hover:text-neteco-700"
              >
                <span class="min-w-0">{{ child.name }}</span>
                <span class="shrink-0 text-xs tabular-nums text-slate-400">{{ child.count }}</span>
              </NuxtLink>
            </div>
            <NuxtLink
              :to="`/categoria/${root.slug}`"
              class="mt-4 block border-t border-slate-100 pt-3 text-sm font-medium text-neteco-600 hover:text-neteco-500"
            >
              Ver todo en {{ root.name }} →
            </NuxtLink>
          </div>
        </div>
      </div>
    </nav>

    <!-- menú móvil -->
    <Teleport to="body">
      <div v-if="mobileOpen" class="fixed inset-0 z-50 lg:hidden" @keydown.escape="mobileOpen = false">
        <div class="absolute inset-0 bg-slate-900/50" @click="mobileOpen = false" />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menú de navegación"
          class="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] flex-col overflow-y-auto bg-white shadow-2xl"
        >
          <div class="flex items-center justify-between border-b border-slate-100 p-4">
            <img src="/logo-texto.png" alt="NETECO" class="h-6 w-auto" />
            <button
              ref="closeBtn"
              class="rounded-lg p-2 hover:bg-slate-100"
              aria-label="Cerrar"
              @click="mobileOpen = false"
            >
              <UIcon name="i-lucide-x" class="block size-5" />
            </button>
          </div>
          <nav class="flex-1 p-2">
            <NuxtLink
              to="/catalogo"
              class="flex items-center gap-2 rounded-lg px-3 py-2.5 font-semibold text-neteco-700 hover:bg-neteco-50"
            >
              <UIcon name="i-lucide-layout-grid" class="size-4" /> Todo el catálogo
            </NuxtLink>
            <div v-for="root in roots" :key="root.id" class="mt-1">
              <button
                class="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left font-medium text-slate-700 hover:bg-slate-50"
                @click="openRoot = openRoot === root.id ? null : root.id"
              >
                {{ root.name }}
                <UIcon
                  name="i-lucide-chevron-down"
                  class="size-4 transition-transform"
                  :class="openRoot === root.id ? 'rotate-180' : ''"
                />
              </button>
              <div v-if="openRoot === root.id" class="ml-2 border-l border-slate-100 pl-2">
                <NuxtLink
                  :to="`/categoria/${root.slug}`"
                  class="block rounded-lg px-3 py-2 text-sm font-medium text-neteco-600 hover:bg-neteco-50"
                >
                  Ver todo ({{ root.count }})
                </NuxtLink>
                <NuxtLink
                  v-for="child in root.children.filter((category) => category.count > 0)"
                  :key="child.id"
                  :to="`/categoria/${child.slug}`"
                  class="block rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-neteco-50"
                >
                  {{ child.name }}
                </NuxtLink>
              </div>
            </div>
          </nav>
          <div class="border-t border-slate-100 p-4 text-sm text-slate-500">
            <a href="tel:600861334" class="flex items-center gap-2 py-1"
              ><UIcon name="i-lucide-phone" class="size-4" /> 600 861 334</a
            >
            <a href="mailto:administracion@neteco.es" class="flex items-center gap-2 py-1"
              ><UIcon name="i-lucide-mail" class="size-4" /> administracion@neteco.es</a
            >
          </div>
        </div>
      </div>
    </Teleport>
  </header>
</template>
