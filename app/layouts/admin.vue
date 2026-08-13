<script setup lang="ts">
const { clear } = useUserSession()

const links = [
  { to: '/admin', label: 'Panel', icon: 'i-lucide-layout-dashboard' },
  { to: '/admin/productos', label: 'Productos', icon: 'i-lucide-package' },
  { to: '/admin/medios', label: 'Medios', icon: 'i-lucide-images' },
  { to: '/admin/categorias', label: 'Familias', icon: 'i-lucide-folder-tree' },
  { to: '/admin/busqueda', label: 'Búsqueda', icon: 'i-lucide-search-check' },
  { to: '/admin/contenido', label: 'Contenido', icon: 'i-lucide-panels-top-left' },
  { to: '/admin/flags', label: 'Flags', icon: 'i-lucide-toggle-right' },
  { to: '/admin/precios', label: 'Precios', icon: 'i-lucide-badge-euro' },
  { to: '/admin/pedidos', label: 'Pedidos', icon: 'i-lucide-receipt-text' },
  { to: '/admin/clientes', label: 'Clientes', icon: 'i-lucide-building-2' },
  { to: '/admin/devoluciones', label: 'Devoluciones', icon: 'i-lucide-rotate-ccw' },
  { to: '/admin/soporte', label: 'Soporte', icon: 'i-lucide-life-buoy' },
  { to: '/admin/operaciones', label: 'Operaciones', icon: 'i-lucide-activity' }
]

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  navigateTo('/')
}
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <header class="sticky top-0 z-40 bg-slate-900 text-white shadow">
      <div class="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5">
        <NuxtLink to="/admin" class="flex shrink-0 items-center gap-2">
          <img src="/logo-figura.png" alt="" class="h-7 w-auto" />
          <span class="font-display font-bold">NETECO</span>
          <span class="rounded bg-neteco-700 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider">Admin</span>
        </NuxtLink>

        <nav class="ml-4 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex">
          <NuxtLink
            v-for="l in links"
            :key="l.to"
            :to="l.to"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
            :class="{
              'bg-slate-800 text-white': l.to === '/admin' ? $route.path === '/admin' : $route.path.startsWith(l.to)
            }"
          >
            <UIcon :name="l.icon" class="size-4" /> {{ l.label }}
          </NuxtLink>
        </nav>

        <div class="ml-auto flex shrink-0 items-center gap-1 text-sm">
          <NuxtLink
            to="/"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <UIcon name="i-lucide-store" class="size-4" /> Ver tienda
          </NuxtLink>
          <button
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
            @click="logout"
          >
            <UIcon name="i-lucide-log-out" class="size-4" /> Salir
          </button>
        </div>
      </div>

      <nav class="flex items-center gap-1 overflow-x-auto border-t border-slate-800 px-4 py-1.5 md:hidden">
        <NuxtLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-300"
          :class="{
            'bg-slate-800 text-white': l.to === '/admin' ? $route.path === '/admin' : $route.path.startsWith(l.to)
          }"
        >
          <UIcon :name="l.icon" class="size-4" /> {{ l.label }}
        </NuxtLink>
      </nav>
    </header>

    <main class="mx-auto max-w-[1600px] px-4 py-6">
      <slot />
    </main>
  </div>
</template>
