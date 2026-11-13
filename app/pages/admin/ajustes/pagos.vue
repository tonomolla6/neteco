<script setup lang="ts">
import type { AdminSetting } from '~/components/admin/ui/AdminSettingsGroup.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const runtime = useRuntimeConfig()
const { terms, deferredPayment } = useCommercialTerms()
const { available, status, settings, refresh } = useAdminSettings()
const loading = computed(() => available && (status.value === 'idle' || status.value === 'pending'))
const pay = computed(() => settings.value?.payments)
const flag = (value: boolean | undefined) => (value === undefined ? null : value)

const card = computed<AdminSetting[]>(() => [
  {
    label: 'Pago con tarjeta',
    help: 'Cobro en la pasarela del banco (Redsys) al terminar la compra.',
    enabled: flag(pay.value?.cardEnabled),
    variable: 'REDSYS_ENABLED'
  },
  {
    label: 'Modo de la pasarela',
    help: 'En pruebas no se mueve dinero real; solo valen las tarjetas de prueba del banco.',
    ...(pay.value
      ? {
          badge:
            pay.value.cardEnvironment === 'production'
              ? { label: 'Real', tone: 'success' as const }
              : pay.value.cardEnvironment === 'sandbox'
                ? { label: 'Pruebas', tone: 'warning' as const }
                : { label: 'Sin configurar', tone: 'warning' as const }
        }
      : { enabled: null }),
    variable: 'REDSYS_ENVIRONMENT'
  },
  {
    label: 'Datos del comercio',
    help: 'Código de comercio, terminal y clave del banco. Por seguridad no se muestran.',
    ...(pay.value
      ? {
          badge: pay.value.cardCredentialsSet
            ? { label: 'Guardados', tone: 'success' as const }
            : { label: 'Faltan', tone: 'warning' as const }
        }
      : { enabled: null }),
    variable: 'REDSYS_MERCHANT_CODE'
  },
  {
    label: 'Bizum',
    help: 'Pago con Bizum a través de la misma pasarela.',
    enabled: flag(pay.value?.bizumEnabled),
    variable: 'REDSYS_BIZUM_ENABLED'
  }
])
const other = computed<AdminSetting[]>(() => [
  {
    label: 'Transferencia bancaria',
    help: 'El cliente recibe los datos de la cuenta y el pedido espera el cobro.',
    enabled: runtime.public.bankTransferEnabled === true,
    variable: 'BANK_TRANSFER_ENABLED'
  },
  {
    label: 'Devoluciones de dinero',
    help: 'Reembolsos a la tarjeta del cliente desde el detalle del pedido.',
    enabled: flag(pay.value?.refundsEnabled),
    variable: 'REFUNDS_ENABLED'
  },
  {
    label: 'Saldo a favor',
    help: 'El cliente puede gastar en la compra el saldo de devoluciones anteriores.',
    enabled: flag(pay.value?.storeCreditEnabled),
    variable: 'STORE_CREDIT_REDEMPTION_ENABLED'
  }
])
const deferred = computed<AdminSetting[]>(() => [
  {
    label: 'Plazo de pago',
    help: 'Días de pago aplazado para empresas con cuenta aprobada.',
    value: terms.value.deferredPaymentDays === null ? '' : `${terms.value.deferredPaymentDays} días`,
    variable: 'COMMERCIAL_DEFERRED_PAYMENT_DAYS'
  },
  {
    label: 'Condiciones',
    help: 'Una frase que se enseña junto al plazo.',
    value: terms.value.deferredPaymentConditions,
    optional: true,
    variable: 'COMMERCIAL_DEFERRED_PAYMENT_CONDITIONS'
  }
])
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminSettingsNotice :failed="status === 'error'" @retry="refresh()" />
      <UAlert
        v-if="settings?.demo"
        color="neutral"
        variant="subtle"
        icon="i-lucide-flask-conical"
        title="Demostración: no se cobra nada"
        description="En esta tienda de demostración los pagos están apagados a propósito. Los pedidos se crean sin cobro real."
      />
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <AdminSettingsGroup
          title="Tarjeta y Bizum"
          description="Pasarela de pago del banco (Redsys)."
          :items="card"
          :loading="loading"
        />
        <div class="adm-stack">
          <AdminSettingsGroup
            title="Otras formas de pago"
            description="Transferencia, devoluciones y saldo."
            :items="other"
            :loading="loading"
          />
          <AdminSettingsGroup
            title="Pago aplazado para empresas"
            description="Condiciones que se anuncian a las empresas con cuenta aprobada."
            :items="deferred"
          >
            <template #footer>
              <p class="adm-help">
                {{ deferredPayment ?? 'Sin plazo configurado, la tienda no anuncia el pago aplazado.' }}
              </p>
            </template>
          </AdminSettingsGroup>
        </div>
      </div>
      <AdminCard title="Dónde se gestiona el día a día" description="Lo que sí se cambia desde el panel.">
        <div class="adm-settings-links">
          <AdminButton to="/admin/preautorizaciones" icon="i-lucide-credit-card">Preautorizaciones</AdminButton>
          <AdminButton to="/admin/checkout-mercados" icon="i-lucide-globe">Pagos por mercado</AdminButton>
          <AdminButton to="/admin/clientes" icon="i-lucide-building-2">Crédito de empresas</AdminButton>
          <AdminButton to="/admin/analitica?tab=payment_funnel" icon="i-lucide-chart-no-axes-combined">
            Embudo de pago
          </AdminButton>
        </div>
      </AdminCard>
    </div>
  </AdminPage>
</template>
