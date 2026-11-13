<script setup lang="ts">
import type { AdminSetting } from '~/components/admin/ui/AdminSettingsGroup.vue'
import { OWN_DELIVERY_ZONE, formatCommercialAmount } from '~~/shared/commercial-terms'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { terms, ownDelivery, parcel } = useCommercialTerms()
const amount = (cents: number | null, zero = 'Sin coste') =>
  cents === null ? '' : cents === 0 ? zero : formatCommercialAmount(cents)

const own = computed<AdminSetting[]>(() => [
  { label: 'Zona de reparto', help: 'Donde reparte la furgoneta propia.', value: OWN_DELIVERY_ZONE },
  {
    label: 'Días de reparto',
    help: 'Tal como se leen en la tienda: «martes y jueves».',
    value: terms.value.ownDeliveryDays,
    variable: 'COMMERCIAL_OWN_DELIVERY_DAYS'
  },
  {
    label: 'Hora de corte',
    help: 'Los pedidos hechos antes de esta hora entran en la siguiente ruta.',
    value: terms.value.orderCutoffTime ? terms.value.orderCutoffTime + ' h' : '',
    variable: 'COMMERCIAL_ORDER_CUTOFF_TIME'
  },
  {
    label: 'Coste del reparto',
    help: 'Con IVA incluido.',
    value: amount(terms.value.ownDeliveryCostCents),
    variable: 'COMMERCIAL_OWN_DELIVERY_COST_CENTS'
  },
  {
    label: 'Reparto gratis desde',
    help: 'Importe del pedido a partir del cual no se cobra el reparto.',
    value: amount(terms.value.ownDeliveryFreeFromCents),
    optional: true,
    variable: 'COMMERCIAL_OWN_DELIVERY_FREE_FROM_CENTS'
  },
  {
    label: 'Pedido mínimo',
    help: 'Importe mínimo para pedir con reparto propio.',
    value: amount(terms.value.ownDeliveryMinimumOrderCents),
    optional: true,
    variable: 'COMMERCIAL_OWN_DELIVERY_MINIMUM_ORDER_CENTS'
  }
])
const agency = computed<AdminSetting[]>(() => [
  {
    label: 'Plazo de entrega',
    help: 'Tal como se lee en la tienda: «24-48 h».',
    value: terms.value.parcelLeadTime,
    variable: 'COMMERCIAL_PARCEL_LEAD_TIME'
  },
  {
    label: 'Portes',
    help: 'Coste del envío estándar por debajo del importe de envío gratis, con IVA.',
    value: amount(terms.value.parcelCostCents),
    variable: 'COMMERCIAL_PARCEL_COST_CENTS'
  },
  {
    label: 'Envío gratis desde',
    help: 'Importe del pedido a partir del cual la paquetería estándar no se cobra.',
    value: amount(terms.value.parcelFreeFromCents),
    variable: 'FREE_SHIPPING_THRESHOLD_CENTS'
  }
])
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminSettingsNotice />
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <AdminSettingsGroup
          title="Reparto propio"
          description="Entregas con vehículo propio en la zona de la tienda."
          :items="own"
        />
        <div class="adm-stack">
          <AdminSettingsGroup
            title="Envío por agencia"
            description="Paquetería estándar para el resto de la península."
            :items="agency"
          />
          <AdminCard
            title="Lo que lee el cliente"
            description="Frases que la tienda compone con estos datos. Sin dato no se promete nada."
          >
            <ul class="grid gap-3">
              <li>
                <p class="adm-label">{{ ownDelivery.title }}</p>
                <p>{{ ownDelivery.text }}</p>
              </li>
              <li v-if="parcel">
                <p class="adm-label">{{ parcel.title }}</p>
                <p>{{ parcel.text }}</p>
              </li>
              <li v-else class="adm-help">
                Sin plazo ni importes configurados, la tienda no anuncia el envío por agencia.
              </li>
            </ul>
          </AdminCard>
        </div>
      </div>
      <AdminCard title="Dónde se gestiona el día a día" description="Lo que sí se cambia desde el panel.">
        <div class="adm-settings-links">
          <AdminButton to="/admin/transportistas" icon="i-lucide-truck">Transportistas</AdminButton>
          <AdminButton to="/admin/rutas" icon="i-lucide-route">Rutas de reparto</AdminButton>
          <AdminButton to="/admin/reglas-precios" icon="i-lucide-scale">Reglas de precio y envío</AdminButton>
          <AdminButton to="/admin/checkout-mercados" icon="i-lucide-globe">Envíos por mercado</AdminButton>
        </div>
      </AdminCard>
    </div>
  </AdminPage>
</template>
