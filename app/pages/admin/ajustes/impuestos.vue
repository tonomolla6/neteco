<script setup lang="ts">
import type { AdminSetting } from '~/components/admin/ui/AdminSettingsGroup.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const runtime = useRuntimeConfig()
const { terms } = useCommercialTerms()
const { available, status, settings, refresh } = useAdminSettings()
const loading = computed(() => available && (status.value === 'idle' || status.value === 'pending'))
const billing = computed(() => settings.value?.billing)
const flag = (value: boolean | undefined) => (value === undefined ? null : value)
const mapped = (rate: '0' | '10' | '21') =>
  billing.value
    ? {
        badge: billing.value.taxRatesMapped.includes(rate)
          ? { label: 'Asignado', tone: 'success' as const }
          : { label: 'Sin asignar', tone: 'neutral' as const }
      }
    : { enabled: null }

const taxes = computed<AdminSetting[]>(() => [
  {
    label: 'Precios de la tienda',
    help: 'Cómo ve los precios el cliente particular. Las empresas con cuenta los ven sin IVA.',
    value: runtime.public.priceDisplayMode === 'net' ? 'Sin IVA' : 'Con IVA incluido',
    variable: 'PRICE_DISPLAY_MODE'
  },
  {
    label: 'IVA general (21 %)',
    help: 'Código del impuesto en el programa de facturación.',
    ...mapped('21'),
    variable: 'BEPLY_TAX_CODE_21'
  },
  { label: 'IVA reducido (10 %)', ...mapped('10'), variable: 'BEPLY_TAX_CODE_10' },
  { label: 'Exento (0 %)', ...mapped('0'), variable: 'BEPLY_TAX_CODE_0' }
])
const invoicing = computed<AdminSetting[]>(() => [
  {
    label: 'Emisión de facturas',
    help: 'Genera la factura de cada pedido cobrado.',
    enabled: flag(billing.value?.invoicingEnabled),
    variable: 'FISCAL_ISSUANCE_ENABLED'
  },
  {
    label: 'Programa de facturación',
    help: 'Conexión con el programa que numera y registra las facturas.',
    ...(billing.value
      ? {
          badge: !billing.value.providerEnabled
            ? { label: 'Sin conectar', tone: 'neutral' as const }
            : billing.value.providerEnvironment === 'production'
              ? { label: 'Conectado', tone: 'success' as const }
              : { label: 'Conectado en pruebas', tone: 'warning' as const }
        }
      : { enabled: null }),
    variable: 'BEPLY_ENABLED'
  },
  {
    label: 'Serie de facturas',
    value: billing.value?.invoiceSeries,
    variable: 'BEPLY_INVOICE_SERIES'
  },
  {
    label: 'Serie de facturas rectificativas',
    help: 'Para devoluciones y correcciones.',
    value: billing.value?.correctiveSeries,
    variable: 'BEPLY_CORRECTIVE_SERIES'
  },
  {
    label: 'Facturas rectificativas',
    help: 'Emisión automática al devolver dinero.',
    enabled: flag(billing.value?.creditNotesEnabled),
    variable: 'CREDIT_DISPATCH_ENABLED'
  },
  {
    label: 'Envío de la factura por correo',
    enabled: flag(settings.value?.email.invoiceEmailsEnabled),
    variable: 'INVOICE_EMAIL_ENABLED'
  }
])
const issuer = computed<AdminSetting[]>(() => [
  { label: 'Razón social', value: terms.value.companyLegalName, variable: 'COMMERCIAL_COMPANY_LEGAL_NAME' },
  { label: 'NIF', value: terms.value.companyTaxId, variable: 'COMMERCIAL_COMPANY_TAX_ID' },
  { label: 'Domicilio fiscal', value: terms.value.companyAddress, variable: 'COMMERCIAL_COMPANY_ADDRESS' }
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
        title="Demostración: no se emiten facturas"
        description="En esta tienda de demostración la facturación está apagada a propósito."
      />
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <AdminSettingsGroup
          title="Facturación"
          description="Emisión de facturas y conexión con el programa de facturación."
          :items="invoicing"
          :loading="loading"
        />
        <div class="adm-stack">
          <AdminSettingsGroup
            title="Impuestos"
            description="Cómo se muestran los precios y qué tipos de IVA están preparados para facturar."
            :items="taxes"
            :loading="loading"
          />
          <AdminSettingsGroup
            title="Emisor de las facturas"
            description="Datos de la empresa que figuran en cada factura."
            :items="issuer"
          >
            <template #actions
              ><AdminButton size="sm" to="/admin/ajustes">Ver datos de la empresa</AdminButton></template
            >
          </AdminSettingsGroup>
        </div>
      </div>
      <AdminCard title="Dónde se gestiona el día a día" description="Lo que sí se cambia desde el panel.">
        <div class="adm-settings-links">
          <AdminButton to="/admin/checkout-mercados" icon="i-lucide-globe">Impuestos por mercado</AdminButton>
          <AdminButton to="/admin/precios" icon="i-lucide-tag">Precios e IVA de cada producto</AdminButton>
          <AdminButton to="/admin/pedidos" icon="i-lucide-receipt-text">Facturas de los pedidos</AdminButton>
        </div>
      </AdminCard>
    </div>
  </AdminPage>
</template>
