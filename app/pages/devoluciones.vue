<script setup lang="ts">
useSeoMeta({
  title: 'Devoluciones',
  description:
    'Cómo devolver un producto NETECO: plazos, condiciones y pasos. En zona de reparto propio lo recogemos nosotros.'
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Devoluciones</h1>
    <p class="mt-2 text-slate-600">Si algo no es lo que esperabas, lo arreglamos rápido y sin vueltas.</p>

    <div class="mt-8 space-y-4">
      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-calendar-days" class="size-5 text-neteco-600" /> Plazo
        </h2>
        <p class="mt-2 text-sm text-slate-600">
          Tienes <b>14 días naturales</b> desde la entrega para solicitar la devolución de cualquier producto.
        </p>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-package-check" class="size-5 text-neteco-600" /> Condiciones
        </h2>
        <ul class="mt-2 list-inside list-disc space-y-1 text-sm text-slate-600">
          <li>El producto debe estar sin abrir y en su embalaje original.</li>
          <li>Por seguridad, los productos químicos abiertos o desprecintados no admiten devolución.</li>
          <li>Si el error es nuestro (producto equivocado o dañado), corremos con todos los gastos, siempre.</li>
        </ul>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 class="flex items-center gap-2 font-bold text-slate-900">
          <UIcon name="i-lucide-rotate-ccw" class="size-5 text-neteco-600" /> Cómo se hace
        </h2>
        <p class="mt-2 text-sm text-slate-600">
          Llámanos al <a href="tel:600861334" class="font-semibold text-neteco-600 underline">600 861 334</a> o escribe
          a
          <a href="mailto:administracion@neteco.es" class="font-semibold text-neteco-600 underline"
            >administracion@neteco.es</a
          >
          con el número de pedido. En la zona de reparto propio <b>pasamos a recogerlo nosotros</b> en la siguiente
          ruta; para envíos por agencia te mandamos una etiqueta de devolución.
        </p>
        <p class="mt-2 text-sm text-slate-600">
          El abono se hace por el mismo método de pago en un máximo de 14 días desde que recibimos el producto.
        </p>
      </div>
    </div>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
