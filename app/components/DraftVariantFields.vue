<script setup lang="ts">
import type { CatalogDraftAuthoringOptions } from '~~/shared/catalog-draft-authoring-options'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'

const props = defineProps<{
  modelValue: unknown
  options: CatalogDraftAuthoringOptions
  prefix: string
  disabled?: boolean
  immutableSku?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const values = computed(() => {
  try {
    const value = catalogPolicyOwnJson(props.modelValue)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
})
const identityFields = [
  { key: 'format', label: 'Formato', maximum: 160 },
  { key: 'ean', label: 'EAN (opcional)', maximum: 64 },
  { key: 'gtin', label: 'GTIN (opcional)', maximum: 64 },
  { key: 'mpn', label: 'Referencia de fabricante (opcional)', maximum: 64 },
  { key: 'color', label: 'Color hexadecimal (opcional)', maximum: 7 }
]
const unitFields = [
  { key: 'contentQuantity', label: 'Contenido por unidad', minimum: 0, nullable: false, decimal: true },
  { key: 'unitsPerCase', label: 'Unidades por caja', minimum: 1, nullable: false },
  { key: 'casesPerPallet', label: 'Cajas por palé (opcional)', minimum: 1, nullable: true },
  { key: 'minimumQuantity', label: 'Cantidad mínima', minimum: 1, nullable: false },
  { key: 'quantityIncrement', label: 'Incremento de cantidad', minimum: 1, nullable: false },
  { key: 'maximumQuantity', label: 'Cantidad máxima (opcional)', minimum: 1, nullable: true }
]
const logisticsFields = [
  { key: 'weightGrams', label: 'Peso (g)', minimum: 0, nullable: false },
  { key: 'widthMm', label: 'Ancho (mm)', minimum: 0, nullable: false },
  { key: 'heightMm', label: 'Alto (mm)', minimum: 0, nullable: false },
  { key: 'depthMm', label: 'Fondo (mm)', minimum: 0, nullable: false },
  { key: 'leadTimeDays', label: 'Plazo (días, opcional)', minimum: 0, nullable: true }
]
function change(key: string, event: Event, numeric = false, nullable = false) {
  if (props.disabled || !values.value || (key === 'sku' && props.immutableSku)) return
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
  let value: unknown = target.value
  if (target instanceof HTMLInputElement && target.type === 'checkbox') value = target.checked
  else if (numeric) value = target.value === '' ? (nullable ? null : '') : Number(target.value)
  else if (nullable && target.value === '') value = null
  emit('update:modelValue', { ...values.value, [key]: value })
}
</script>

<template>
  <div v-if="values" class="space-y-5">
    <fieldset :disabled="disabled" class="space-y-3">
      <legend class="font-semibold text-[var(--text-strong)]">Identidad de la variante</legend>
      <div class="grid gap-3 sm:grid-cols-2">
        <label :for="`${prefix}-sku`" class="text-sm">
          SKU {{ immutableSku ? '(fijo)' : '' }}
          <input
            :id="`${prefix}-sku`"
            data-field="sku"
            class="draft-field"
            :value="values.sku"
            :readonly="immutableSku"
            :required="!immutableSku"
            maxlength="64"
            @input="change('sku', $event)"
          />
        </label>
        <label v-for="field in identityFields" :key="field.key" :for="`${prefix}-${field.key}`" class="text-sm">
          {{ field.label }}
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="draft-field"
            :value="values[field.key] ?? ''"
            :maxlength="field.maximum"
            :required="field.key === 'format'"
            @input="change(field.key, $event, false, field.key !== 'format')"
          />
        </label>
      </div>
    </fieldset>
    <fieldset :disabled="disabled" class="space-y-3">
      <legend class="font-semibold text-[var(--text-strong)]">Unidades y cantidades</legend>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label
          v-for="field in [
            { key: 'unitBase', label: 'Unidad base', maximum: 40 },
            { key: 'unitLabel', label: 'Etiqueta de unidad', maximum: 80 }
          ]"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          class="text-sm"
        >
          {{ field.label }}
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="draft-field"
            :value="values[field.key]"
            :maxlength="field.maximum"
            required
            @input="change(field.key, $event)"
          />
        </label>
        <label v-for="field in unitFields" :key="field.key" :for="`${prefix}-${field.key}`" class="text-sm">
          {{ field.label }}
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="draft-field"
            type="number"
            :value="values[field.key] ?? ''"
            :min="field.minimum"
            :step="field.decimal ? 'any' : 1"
            :required="!field.nullable"
            @input="change(field.key, $event, true, field.nullable)"
          />
        </label>
      </div>
    </fieldset>
    <fieldset :disabled="disabled" class="space-y-3">
      <legend class="font-semibold text-[var(--text-strong)]">Fiscalidad y logística</legend>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label :for="`${prefix}-taxClassId`" class="text-sm">
          Clase fiscal
          <select
            :id="`${prefix}-taxClassId`"
            data-field="taxClassId"
            class="draft-field"
            :value="values.taxClassId"
            required
            @change="change('taxClassId', $event)"
          >
            <option value="">Selecciona una referencia</option>
            <option v-for="entry in options.taxClasses" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
          </select>
        </label>
        <label :for="`${prefix}-shippingProfileId`" class="text-sm">
          Perfil de envío
          <select
            :id="`${prefix}-shippingProfileId`"
            data-field="shippingProfileId"
            class="draft-field"
            :value="values.shippingProfileId"
            required
            @change="change('shippingProfileId', $event)"
          >
            <option value="">Selecciona una referencia</option>
            <option v-for="entry in options.shippingProfiles" :key="entry.id" :value="entry.id">
              {{ entry.name }}
            </option>
          </select>
        </label>
        <label v-for="field in logisticsFields" :key="field.key" :for="`${prefix}-${field.key}`" class="text-sm">
          {{ field.label }}
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="draft-field"
            type="number"
            :value="values[field.key] ?? ''"
            :min="field.minimum"
            step="1"
            :required="!field.nullable"
            @input="change(field.key, $event, true, field.nullable)"
          />
        </label>
        <label :for="`${prefix}-backorderAllowed`" class="flex items-center gap-2 text-sm">
          <input
            :id="`${prefix}-backorderAllowed`"
            data-field="backorderAllowed"
            type="checkbox"
            :checked="values.backorderAllowed === true"
            @change="change('backorderAllowed', $event)"
          />
          Permitir pedidos pendientes
        </label>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.draft-field {
  display: block;
  width: 100%;
  min-width: 0;
  margin-top: 0.25rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 0.5rem;
  background: var(--surface);
  color: var(--text-strong);
}
.draft-field:focus-visible {
  outline: 2px solid var(--color-neteco-600);
  outline-offset: 1px;
}
</style>
