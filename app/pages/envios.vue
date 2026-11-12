<script setup lang="ts">
import { formatCommercialAmount } from '~~/shared/commercial-terms'

useSeoMeta({
  title: 'Envíos y reparto',
  description:
    "Zonas, plazos y costes de entrega de NETECO: reparto propio en Ontinyent y la Vall d'Albaida, envío por agencia a península y recogida en almacén."
})

/**
 * La copia anterior estaba escrita desde dentro del sistema: «tarifa server-side antes del
 * pago», «ventana calculada por carrier», «modalidad autorizada». Un hostelero que quiere
 * saber cuándo le llega el pedido no habla así. Los hechos son los mismos; cambia quién es
 * el sujeto de la frase.
 */
const { terms, email: contactEmail } = useCommercialTerms()
/**
 * Zona, plazo y coste con el dato del negocio cuando existe. Sin dato, la celda dice dónde
 * lo verá el cliente (al indicar el código postal, antes de pagar) o a quién preguntar.
 */
const methods = computed(() => {
  const t = terms.value
  const ownCost =
    t.ownDeliveryCostCents === 0
      ? 'Gratis'
      : [
          t.ownDeliveryCostCents !== null ? formatCommercialAmount(t.ownDeliveryCostCents) : '',
          t.ownDeliveryFreeFromCents !== null
            ? `gratis desde ${formatCommercialAmount(t.ownDeliveryFreeFromCents)}`
            : ''
        ]
          .filter(Boolean)
          .join(', ')
  const parcelCost = [
    t.parcelCostCents ? formatCommercialAmount(t.parcelCostCents) : '',
    t.parcelFreeFromCents !== null
      ? `gratis desde ${formatCommercialAmount(t.parcelFreeFromCents)} en paquetería estándar`
      : ''
  ]
    .filter(Boolean)
    .join(', ')
  return [
    {
      icon: 'i-lucide-truck',
      title: 'Te lo llevamos nosotros',
      zone: 'Ontinyent y la Vall d’Albaida',
      time: t.ownDeliveryDays
        ? `${capitalize(t.ownDeliveryDays)}${t.orderCutoffTime ? `. Pide antes de las ${t.orderCutoffTime}` : ''}`
        : `${t.contactPhone || t.supportPhoneAi ? 'Llámanos' : 'Escríbenos'} y te decimos el próximo día de ruta`,
      cost: ownCost ? capitalize(ownCost) : 'Lo ves antes de pagar, al indicar tu código postal',
      note: `${
        t.ownDeliveryMinimumOrderCents !== null
          ? `Pedido mínimo para el reparto: ${formatCommercialAmount(t.ownDeliveryMinimumOrderCents)}. `
          : ''
      }Indica cualquier dificultad de acceso en las instrucciones del pedido.`
    },
    {
      icon: 'i-lucide-package',
      title: 'Envío por agencia',
      zone: 'Península',
      time: t.parcelLeadTime || 'Lo ves al elegir el envío en el pedido',
      cost: parcelCost ? capitalize(parcelCost) : 'Lo ves antes de pagar, según destino y peso',
      note: 'Los productos voluminosos y los que viajan como mercancía peligrosa tienen condiciones propias, que se comprueban al calcular el envío.'
    },
    {
      icon: 'i-lucide-store',
      title: 'Lo recoges tú',
      zone: 'Nuestro almacén en Ontinyent',
      time: 'Te avisamos cuando esté preparado',
      cost: 'Gratis',
      note: 'Trae el número de pedido.'
    }
  ]
})
function capitalize(value: string) {
  return value.charAt(0).toLocaleUpperCase('es') + value.slice(1)
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold text-slate-900 sm:text-3xl">Envíos y reparto</h1>
    <p class="mt-2 text-slate-600">
      Nuestra diferencia es el reparto propio: en la comarca te lo llevamos nosotros, sin agencias de por medio.
    </p>

    <div class="mt-8 space-y-4">
      <div
        v-for="m in methods"
        :key="m.title"
        class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6"
      >
        <div class="flex items-start gap-4">
          <span class="rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] p-3 text-[var(--text-muted)]">
            <UIcon :name="m.icon" class="block size-6" />
          </span>
          <div class="flex-1">
            <h2 class="text-lg font-bold text-slate-900">{{ m.title }}</h2>
            <dl class="mt-3 grid gap-x-8 gap-y-2 text-sm grid-cols-1 sm:grid-cols-3">
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

    <div class="mt-8 rounded-[var(--radius-panel)] bg-neteco-50 p-6">
      <h2 class="flex items-center gap-2 font-bold text-neteco-900">
        <UIcon name="i-lucide-phone" class="size-5 text-neteco-600" /> ¿Dudas con tu entrega?
      </h2>
      <p class="mt-2 text-sm text-neteco-800">
        <template v-if="terms.contactPhone">
          Llámanos al
          <a :href="`tel:${terms.contactPhone.replace(/[^\d+]/g, '')}`" class="font-semibold underline">{{
            terms.contactPhone
          }}</a
          ><template v-if="terms.supportHours"> ({{ terms.supportHours }})</template> o escribe a
        </template>
        <template v-else>Escríbenos a</template>
        <a :href="`mailto:${contactEmail}`" class="font-semibold underline">{{ contactEmail }}</a
        >. Te responde quien conoce tu pedido.
      </p>
    </div>

    <div class="mt-8 text-center">
      <UButton to="/catalogo" variant="soft" icon="i-lucide-layout-grid">Ver el catálogo</UButton>
    </div>
  </div>
</template>
