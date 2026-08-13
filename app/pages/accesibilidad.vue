<script setup lang="ts">
useSeoMeta({ title: 'Accesibilidad', description: 'Estado de accesibilidad y canal de feedback de NETECO Shop.' })
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-10">
    <h1 class="text-3xl font-bold text-slate-950">Accesibilidad</h1>
    <p class="mt-4 text-slate-700">
      NETECO trabaja con WCAG 2.2 AA como objetivo técnico para la tienda, cuenta, checkout y panel. La revisión interna
      incluye teclado, foco visible, nombres accesibles, zoom/reflow y comprobaciones automatizadas. Aún no se presenta
      esta página como certificación ni sustituye una auditoría externa.
    </p>
    <h2 class="mt-8 text-xl font-bold text-slate-900">Limitaciones y mejora continua</h2>
    <p class="mt-2 text-slate-700">
      Los documentos PDF históricos y algunos contenidos aportados por fabricantes pueden requerir adaptación o una
      alternativa accesible. Los assets pendientes de derechos y validación permanecen fuera de la puerta de
      publicación.
    </p>
    <h2 class="mt-8 text-xl font-bold text-slate-900">Comunicar una barrera</h2>
    <p class="mt-2 text-slate-700">
      Indica la URL, tarea, navegador y tecnología de asistencia mediante el
      <NuxtLink to="/contacto" class="font-semibold text-neteco-700 underline">formulario de soporte</NuxtLink> o llama
      al <a href="tel:600861334" class="font-semibold text-neteco-700 underline">600 861 334</a>. La incidencia recibe
      referencia y SLA igual que el resto de soporte.
    </p>
    <p class="mt-8 text-sm text-slate-500">Última revisión interna de esta declaración: 13 de agosto de 2026.</p>
  </div>
</template>
