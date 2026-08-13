<script setup lang="ts">
useSeoMeta({
  title: 'Envíos y reparto',
  description:
    "Zonas, plazos y costes de entrega de NETECO: reparto propio en Ontinyent y la Vall d'Albaida, envío por agencia a península y recogida en almacén."
})

const methods = [
  {
    icon: 'i-lucide-truck',
    title: 'Reparto propio NETECO',
    zone: 'Códigos postales y rutas configurados',
    time: 'Fecha calculada en checkout',
    cost: 'Según destino y mercancía',
    note: 'El checkout valida si existe ruta propia para el código postal y calcula una fecha real. Las instrucciones de muelle o acceso se revisan antes de confirmar la expedición.'
  },
  {
    icon: 'i-lucide-package',
    title: 'Envío por agencia',
    zone: 'Destinos aceptados por el servicio contratado',
    time: 'Ventana calculada por carrier',
    cost: 'Tarifa server-side antes del pago',
    note: 'Peso, volumen, bultos y restricciones determinan los servicios elegibles. Mercancía ADR o palé solo se ofrece cuando existe una modalidad autorizada.'
  },
  {
    icon: 'i-lucide-store',
    title: 'Recogida en almacén',
    zone: 'Ontinyent',
    time: 'Te avisamos cuando esté listo',
    cost: 'Gratis',
    note: 'Te avisamos por teléfono o email cuando tu pedido esté preparado.'
  }
]
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Envíos y reparto</h1>
    <p class="mt-2 text-slate-600">
      Nuestra diferencia es el reparto propio: en la comarca te lo llevamos nosotros, sin agencias de por medio.
    </p>

    <div class="mt-8 space-y-4">
      <div v-for="m in methods" :key="m.title" class="rounded-2xl border border-slate-200 bg-white p-6">
        <div class="flex items-start gap-4">
          <span class="rounded-xl bg-neteco-50 p-3 text-neteco-600">
            <UIcon :name="m.icon" class="block size-6" />
          </span>
          <div class="flex-1">
            <h2 class="text-lg font-bold text-slate-900">{{ m.title }}</h2>
            <dl class="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt class="text-slate-500">Zona</dt>
                <dd class="mt-0.5 font-medium text-slate-800">{{ m.zone }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Plazo</dt>
                <dd class="mt-0.5 font-medium text-slate-800">{{ m.time }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Coste</dt>
                <dd class="mt-0.5 font-medium text-slate-800">{{ m.cost }}</dd>
              </div>
            </dl>
            <p class="mt-3 text-sm text-slate-500">{{ m.note }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-8 rounded-2xl bg-neteco-50 p-6">
      <h2 class="flex items-center gap-2 font-bold text-neteco-900">
        <UIcon name="i-lucide-phone" class="size-5 text-neteco-600" /> ¿Dudas con tu entrega?
      </h2>
      <p class="mt-2 text-sm text-neteco-800">
        Llámanos al <a href="tel:600861334" class="font-semibold underline">600 861 334</a> (lunes a viernes,
        09:00-18:00) o escribe a
        <a href="mailto:administracion@neteco.es" class="font-semibold underline">administracion@neteco.es</a>. Hablas
        con personas que conocen tu pedido.
      </p>
    </div>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
