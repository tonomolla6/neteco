<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Panel de administración' })

const { data: stats } = await useFetch('/api/admin/stats')

const cards = computed(() => [
  {
    label: 'Productos',
    value: (stats.value as any)?.products ?? '—',
    icon: 'i-lucide-package',
    to: '/admin/productos'
  },
  {
    label: 'Variantes / referencias',
    value: (stats.value as any)?.variants ?? '—',
    icon: 'i-lucide-list',
    to: '/admin/productos'
  },
  {
    label: 'Familias',
    value: (stats.value as any)?.categories ?? '—',
    icon: 'i-lucide-folder-tree',
    to: '/admin/categorias'
  },
  {
    label: 'Pedidos (abiertos)',
    value: `${(stats.value as any)?.orders ?? '—'} (${(stats.value as any)?.openOrders ?? '—'})`,
    icon: 'i-lucide-receipt-text',
    to: '/admin/pedidos'
  },
  {
    label: 'Clientes registrados',
    value: (stats.value as any)?.users ?? '—',
    icon: 'i-lucide-users',
    to: '/admin/clientes'
  }
])
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold text-slate-900">Panel de administración</h1>
      <div class="flex gap-2">
        <UButton to="/admin/productos/nuevo" icon="i-lucide-plus">Nuevo producto</UButton>
        <UButton to="/admin/categorias" variant="soft" icon="i-lucide-folder-plus">Nueva familia</UButton>
      </div>
    </div>

    <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <NuxtLink
        v-for="c in cards"
        :key="c.label"
        :to="c.to"
        class="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300"
      >
        <UIcon :name="c.icon" class="size-5 text-neteco-600" />
        <p class="mt-2 font-display text-2xl font-bold text-slate-900">{{ c.value }}</p>
        <p class="text-sm text-slate-500">{{ c.label }}</p>
      </NuxtLink>
    </div>

    <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-600">
      <h2 class="flex items-center gap-2 font-bold text-slate-900">
        <UIcon name="i-lucide-database" class="size-4 text-neteco-600" /> Cómo funciona la base de datos
      </h2>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li>
          Los datos viven en <code class="rounded bg-slate-100 px-1">.data/neteco.db</code> (SQLite) y
          <strong>ya no hace falta borrarla</strong>: los cambios de esquema se aplican solos al arrancar.
        </li>
        <li>
          Todo lo que des de alta aquí se guarda ahí directamente; el seed de demostración solo se ejecuta si la base
          está vacía.
        </li>
        <li>
          Copia de seguridad: <code class="rounded bg-slate-100 px-1">npm run db:backup</code> crea un archivo fechado
          en <code class="rounded bg-slate-100 px-1">.data/backups/</code>.
        </li>
        <li>
          En productos, la <strong>referencia de cada variante es el código de artículo del ERP</strong>: es el vínculo
          para el futuro importador, no lo cambies a la ligera.
        </li>
      </ul>
    </div>
  </div>
</template>
