<script setup lang="ts">
import type { AdminSetting } from '~/components/admin/ui/AdminSettingsGroup.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { email: contactEmail } = useCommercialTerms()
const { available, status, settings, refresh } = useAdminSettings()
const loading = computed(() => available && (status.value === 'idle' || status.value === 'pending'))
const mail = computed(() => settings.value?.email)
const flag = (value: boolean | undefined) => (value === undefined ? null : value)

const customers = computed<AdminSetting[]>(() => [
  {
    label: 'Correos de pedidos',
    help: 'Confirmación del pedido, pago recibido, envío y entrega.',
    enabled: flag(mail.value?.orderEmailsEnabled),
    variable: 'TRANSACTIONAL_EMAIL_ENABLED'
  },
  {
    label: 'Remitente de los pedidos',
    help: 'Dirección desde la que salen esos correos.',
    value: mail.value?.orderEmailsFrom,
    variable: 'TRANSACTIONAL_EMAIL_FROM'
  },
  {
    label: 'Correos de la cuenta',
    help: 'Verificación del correo, cambio de contraseña e invitaciones.',
    enabled: flag(mail.value?.accountEmailsEnabled),
    variable: 'AUTH_EMAIL_ENABLED'
  },
  { label: 'Remitente de la cuenta', value: mail.value?.accountEmailsFrom, variable: 'AUTH_EMAIL_FROM' },
  {
    label: 'Factura por correo',
    help: 'Envía la factura al cliente cuando se emite.',
    enabled: flag(mail.value?.invoiceEmailsEnabled),
    variable: 'INVOICE_EMAIL_ENABLED'
  },
  {
    label: 'Correo de contacto de la tienda',
    help: 'El que ve el cliente para escribir a la tienda.',
    value: contactEmail.value,
    variable: 'COMMERCIAL_CONTACT_EMAIL'
  }
])
const newsletter = computed<AdminSetting[]>(() => [
  {
    label: 'Suscripción al boletín',
    help: 'Formulario de alta en la tienda, con confirmación por correo.',
    enabled: flag(mail.value?.newsletterEnabled),
    variable: 'NEWSLETTER_ENABLED'
  },
  {
    label: 'Envío de campañas',
    help: 'Permite enviar las campañas preparadas en Comunicaciones.',
    enabled: flag(mail.value?.newsletterSendingEnabled),
    variable: 'NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED'
  },
  { label: 'Remitente del boletín', value: mail.value?.newsletterFrom, variable: 'NEWSLETTER_EMAIL_FROM' }
])
const automatic = computed<AdminSetting[]>(() => [
  {
    label: 'Avisos de existencias',
    help: 'Avisa al equipo cuando un producto baja del mínimo.',
    enabled: flag(mail.value?.stockAlertsEnabled),
    variable: 'INVENTORY_ALERTS_ENABLED'
  },
  {
    label: 'Recuperación de carritos',
    help: 'Recuerda por correo a los clientes los carritos sin terminar.',
    enabled: flag(mail.value?.cartRecoveryEnabled),
    variable: 'CART_RECOVERY_DELIVERY_ENABLED'
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
        title="Demostración: no se envían correos"
        description="En esta tienda de demostración el envío de correos está apagado a propósito."
      />
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <AdminSettingsGroup
          title="Correos a clientes"
          description="Mensajes automáticos de pedidos, cuenta y facturas."
          :items="customers"
          :loading="loading"
        />
        <div class="adm-stack">
          <AdminSettingsGroup
            title="Boletín"
            description="Suscripciones y campañas comerciales."
            :items="newsletter"
            :loading="loading"
          />
          <AdminSettingsGroup
            title="Avisos automáticos"
            description="Mensajes que salen solos según lo que pasa en la tienda."
            :items="automatic"
            :loading="loading"
          />
        </div>
      </div>
      <AdminCard title="Dónde se gestiona el día a día" description="Lo que sí se cambia desde el panel.">
        <div class="adm-settings-links">
          <AdminButton to="/admin/alertas-operativas" icon="i-lucide-bell-ring">Avisos del equipo</AdminButton>
          <AdminButton to="/admin/newsletter" icon="i-lucide-mail">Campañas del boletín</AdminButton>
          <AdminButton to="/admin/automatizaciones" icon="i-lucide-workflow">Correos automáticos</AdminButton>
          <AdminButton to="/admin/comunicaciones-multicanal" icon="i-lucide-messages-square"
            >Plantillas y canales</AdminButton
          >
        </div>
      </AdminCard>
    </div>
  </AdminPage>
</template>
