<script setup lang="ts">
/**
 * Identificación del titular (art. 10 LSSI-CE), leída de la configuración comercial.
 * Una fila obligatoria sin dato se ve como pendiente fuera de producción y desaparece en
 * producción. Teléfono y horario no los exige la ley: solo salen si están configurados.
 */
const { terms, email } = useCommercialTerms()
const production = useRuntimeConfig().public.appEnv === 'production'

const rows = computed(() =>
  [
    { key: 'name', term: 'Titular', value: terms.value.companyLegalName, label: 'razón social' },
    { key: 'tax', term: 'NIF', value: terms.value.companyTaxId, label: 'NIF' },
    { key: 'address', term: 'Domicilio', value: terms.value.companyAddress, label: 'domicilio' },
    { key: 'registry', term: 'Datos registrales', value: terms.value.companyRegistry, label: 'datos registrales' },
    { key: 'phone', term: 'Teléfono', value: terms.value.contactPhone, label: 'teléfono', optional: true },
    { key: 'hours', term: 'Horario de atención', value: terms.value.supportHours, label: 'horario', optional: true }
  ].filter((row) => row.value || (!production && !row.optional))
)
</script>

<template>
  <dl data-legal-identity class="legal-identity">
    <div v-for="row in rows" :key="row.key">
      <dt>{{ row.term }}</dt>
      <dd><LegalDatum :value="row.value" :label="row.label" /></dd>
    </div>
    <div>
      <dt>Correo electrónico</dt>
      <dd>
        <a :href="`mailto:${email}`">{{ email }}</a>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.legal-identity {
  margin-top: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-surface);
  background: var(--surface);
  overflow: hidden;
  max-width: 44rem;
}
.legal-identity > div {
  display: grid;
  gap: 0.125rem;
  padding: 0.75rem 1rem;
}
.legal-identity > div + div {
  border-top: 1px solid var(--border);
}
@media (min-width: 640px) {
  .legal-identity > div {
    grid-template-columns: 12rem minmax(0, 1fr);
    gap: 1rem;
    padding: 0;
  }
  .legal-identity dt,
  .legal-identity dd {
    padding: 0.75rem 1rem;
  }
  .legal-identity dt {
    background: var(--surface-sunken);
  }
}
.legal-identity dt {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--text-strong);
}
.legal-identity dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
}
</style>
