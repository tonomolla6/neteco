<script setup lang="ts">
import type { AdminSetting } from '~/components/admin/ui/AdminSettingsGroup.vue'
import { DEFAULT_CONTACT_EMAIL } from '~~/shared/commercial-terms'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const runtime = useRuntimeConfig()
const { terms } = useCommercialTerms()
const { available, status, settings, refresh } = useAdminSettings()
const loading = computed(() => available && (status.value === 'idle' || status.value === 'pending'))
const raw = computed(() => (runtime.public.commercial ?? {}) as Record<string, unknown>)

const ENVIRONMENTS: Record<string, string> = {
  production: 'Producción (tienda real)',
  preview: 'Demostración',
  preprod: 'Preproducción',
  preproduction: 'Preproducción',
  canary: 'Prueba controlada',
  local: 'Desarrollo local'
}
const company = computed<AdminSetting[]>(() => [
  {
    label: 'Razón social',
    help: 'Titular de la tienda. Aparece en el aviso legal y en las condiciones.',
    value: terms.value.companyLegalName,
    variable: 'COMMERCIAL_COMPANY_LEGAL_NAME'
  },
  {
    label: 'NIF',
    help: 'Se muestra en el pie y en las páginas legales.',
    value: terms.value.companyTaxId,
    variable: 'COMMERCIAL_COMPANY_TAX_ID'
  },
  { label: 'Domicilio', value: terms.value.companyAddress, variable: 'COMMERCIAL_COMPANY_ADDRESS' },
  {
    label: 'Datos registrales',
    help: 'Inscripción en el Registro Mercantil u otro registro público.',
    value: terms.value.companyRegistry,
    variable: 'COMMERCIAL_COMPANY_REGISTRY'
  },
  {
    label: 'Correo de protección de datos',
    help: 'Si no se indica, se usa el correo de contacto.',
    value: terms.value.dpoEmail,
    optional: true,
    variable: 'COMMERCIAL_DPO_EMAIL'
  },
  {
    label: 'Entidad de resolución de litigios',
    help: 'Solo si la tienda está adherida a alguna.',
    value: terms.value.disputeResolutionEntity,
    optional: true,
    variable: 'COMMERCIAL_DISPUTE_RESOLUTION_ENTITY'
  },
  {
    label: 'Año de fundación',
    value: terms.value.foundedYear,
    optional: true,
    variable: 'COMMERCIAL_FOUNDED_YEAR'
  }
])
const contact = computed<AdminSetting[]>(() => [
  {
    label: 'Correo de contacto',
    help:
      raw.value.contactEmail && terms.value.contactEmail !== DEFAULT_CONTACT_EMAIL
        ? 'Único correo que ve el cliente en toda la tienda.'
        : 'Único correo que ve el cliente. No se ha indicado otro: se usa el predeterminado.',
    value: terms.value.contactEmail,
    variable: 'COMMERCIAL_CONTACT_EMAIL'
  },
  {
    label: 'Teléfono',
    help: 'Atendido por personas. Vacío: no se muestra ningún teléfono.',
    value: terms.value.contactPhone,
    variable: 'COMMERCIAL_CONTACT_PHONE'
  },
  {
    label: 'Teléfono con asistente automático',
    value: terms.value.supportPhoneAi,
    optional: true,
    variable: 'COMMERCIAL_SUPPORT_PHONE_AI'
  },
  {
    label: 'WhatsApp',
    help: 'Número por el que se atienden pedidos.',
    value: terms.value.whatsappNumber ? '+' + terms.value.whatsappNumber : '',
    optional: true,
    variable: 'COMMERCIAL_WHATSAPP_NUMBER'
  },
  {
    label: 'Horario de atención',
    help: 'Tal como se lee en la tienda: «de lunes a viernes de 9:00 a 18:00».',
    value: terms.value.supportHours,
    variable: 'COMMERCIAL_SUPPORT_HOURS'
  }
])
const shop = computed<AdminSetting[]>(() => [
  { label: 'Dirección de la tienda', value: String(runtime.public.baseUrl ?? ''), variable: 'NUXT_PUBLIC_BASE_URL' },
  {
    label: 'Entorno',
    help: 'Indica si esta es la tienda real o una copia de pruebas.',
    value: ENVIRONMENTS[String(runtime.public.appEnv)] ?? adminHumanize(String(runtime.public.appEnv ?? '')),
    variable: 'APP_ENV'
  },
  {
    label: 'Versión publicada',
    value: String(runtime.public.appVersion ?? ''),
    optional: true,
    variable: 'APP_VERSION'
  },
  {
    label: 'Gama ecológica',
    help: 'Nombre comercial de la gama propia.',
    value: terms.value.ecoRangeBrand,
    optional: true,
    variable: 'COMMERCIAL_ECO_RANGE_BRAND'
  },
  {
    label: 'Certificados publicados',
    help: 'Solo se anuncian si hay certificados reales cargados.',
    badge: terms.value.certificationsPublished ? { label: 'Sí', tone: 'success' } : { label: 'No', tone: 'neutral' },
    variable: 'COMMERCIAL_CERTIFICATIONS_PUBLISHED'
  },
  {
    label: 'Condiciones de compra',
    value: String(runtime.public.legalTermsUrl ?? ''),
    variable: 'NUXT_PUBLIC_LEGAL_TERMS_URL'
  },
  {
    label: 'Política de privacidad',
    value: String(runtime.public.privacyUrl ?? ''),
    variable: 'NUXT_PUBLIC_PRIVACY_URL'
  },
  { label: 'Política de cookies', value: String(runtime.public.cookiesUrl ?? ''), variable: 'NUXT_PUBLIC_COOKIES_URL' }
])
const services = computed<AdminSetting[]>(() => {
  const s = settings.value?.services
  const state = (value: boolean | undefined) => (value === undefined ? null : value)
  return [
    {
      label: 'Atención al cliente',
      help: 'Formulario de contacto y buzón de consultas.',
      enabled: state(s?.support),
      variable: 'SUPPORT_ENABLED'
    },
    {
      label: 'Analítica',
      help: 'Visitas, conversión y búsquedas.',
      enabled: state(s?.analytics),
      variable: 'ANALYTICS_ENABLED'
    },
    {
      label: 'Boletín',
      help: 'Suscripción desde la tienda y campañas.',
      enabled: state(s?.newsletter),
      variable: 'NEWSLETTER_ENABLED'
    },
    {
      label: 'Presupuestos',
      help: 'Ofertas a clientes que se convierten en pedido.',
      enabled: state(s?.quotes),
      variable: 'SALES_QUOTES_ENABLED'
    },
    {
      label: 'Reseñas y preguntas',
      help: 'Opiniones de clientes en las fichas.',
      enabled: state(s?.reviews),
      variable: 'PRODUCT_CONTRIBUTIONS_ENABLED'
    },
    {
      label: 'Imágenes y archivos',
      help: 'Biblioteca de imágenes del catálogo.',
      enabled: state(s?.media),
      variable: 'MEDIA_ADMIN_ENABLED'
    },
    {
      label: 'Publicación de contenido',
      help: 'Páginas y artículos de la tienda.',
      enabled: state(s?.content),
      variable: 'CMS_PUBLICATION_ENABLED'
    },
    {
      label: 'API para clientes',
      help: 'Acceso de otros sistemas con clave.',
      enabled: state(s?.publicApi),
      variable: 'B2B_PUBLIC_API_ENABLED'
    }
  ]
})
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminSettingsNotice :failed="status === 'error'" @retry="refresh()" />
      <div class="grid items-start gap-5 xl:grid-cols-2">
        <AdminSettingsGroup
          title="Datos de la empresa"
          description="Identidad legal del titular. Se usan en el pie, el aviso legal y las condiciones."
          :items="company"
        />
        <div class="adm-stack">
          <AdminSettingsGroup
            title="Contacto y horario"
            description="Cómo te localiza un cliente. Es lo que se muestra en toda la tienda."
            :items="contact"
          />
        </div>
      </div>
      <AdminSettingsGroup title="Tienda" description="Dirección, entorno y páginas legales." :items="shop" />
      <AdminSettingsGroup
        v-if="available"
        id="funciones"
        title="Funciones de la tienda"
        description="Qué partes opcionales están en marcha. Una función desactivada no muestra datos en su pantalla del panel."
        :items="services"
        :loading="loading"
      />
    </div>
  </AdminPage>
</template>
