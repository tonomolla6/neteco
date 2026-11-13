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
const identityFields: Array<{ key: string; label: string; maximum: number; help?: string; placeholder?: string }> = [
  { key: 'format', label: 'Formato', maximum: 160, help: 'Por ejemplo, «Garrafa de 5 l».' },
  { key: 'ean', label: 'Código de barras EAN (opcional)', maximum: 64 },
  { key: 'gtin', label: 'Código GTIN (opcional)', maximum: 64 },
  { key: 'mpn', label: 'Referencia del fabricante (opcional)', maximum: 64 },
  { key: 'color', label: 'Color (opcional)', maximum: 7, help: 'Código de color web.', placeholder: '#1A7F4B' }
]
const unitTextFields = [
  { key: 'unitBase', label: 'Unidad de medida', maximum: 40, help: 'En qué se mide el contenido: l, kg, ud…' },
  { key: 'unitLabel', label: 'Nombre de la unidad', maximum: 80, help: 'Como se muestra al cliente.' }
]
const unitFields = [
  { key: 'contentQuantity', label: 'Contenido por unidad', minimum: 0, nullable: false, decimal: true },
  { key: 'unitsPerCase', label: 'Unidades por caja', minimum: 1, nullable: false },
  { key: 'casesPerPallet', label: 'Cajas por palé (opcional)', minimum: 1, nullable: true },
  { key: 'minimumQuantity', label: 'Pedido mínimo', minimum: 1, nullable: false },
  { key: 'quantityIncrement', label: 'Se pide en múltiplos de', minimum: 1, nullable: false },
  { key: 'maximumQuantity', label: 'Pedido máximo (opcional)', minimum: 1, nullable: true }
]
const logisticsFields = [
  { key: 'weightGrams', label: 'Peso (g)', minimum: 0, nullable: false },
  { key: 'widthMm', label: 'Ancho (mm)', minimum: 0, nullable: false },
  { key: 'heightMm', label: 'Alto (mm)', minimum: 0, nullable: false },
  { key: 'depthMm', label: 'Fondo (mm)', minimum: 0, nullable: false },
  { key: 'leadTimeDays', label: 'Plazo de entrega en días (opcional)', minimum: 0, nullable: true }
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
  <div v-if="values" class="adm-stack">
    <fieldset :disabled="disabled" class="adm-stack">
      <legend class="adm-section__title">Identificación de la variante</legend>
      <div class="adm-form-grid">
        <AdminFormField
          :for="`${prefix}-sku`"
          label="Referencia (SKU)"
          :help="immutableSku ? 'No se puede cambiar una vez creada la variante.' : undefined"
          :required="!immutableSku"
        >
          <input
            :id="`${prefix}-sku`"
            data-field="sku"
            class="adm-input"
            :value="values.sku"
            :readonly="immutableSku"
            :required="!immutableSku"
            maxlength="64"
            @input="change('sku', $event)"
          />
        </AdminFormField>
        <AdminFormField
          v-for="field in identityFields"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          :label="field.label"
          :help="field.help"
          :required="field.key === 'format'"
        >
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="adm-input"
            :value="values[field.key] ?? ''"
            :maxlength="field.maximum"
            :placeholder="field.placeholder"
            :required="field.key === 'format'"
            @input="change(field.key, $event, false, field.key !== 'format')"
          />
        </AdminFormField>
      </div>
    </fieldset>
    <fieldset :disabled="disabled" class="adm-stack">
      <legend class="adm-section__title">Unidades y cantidades</legend>
      <div class="adm-form-grid">
        <AdminFormField
          v-for="field in unitTextFields"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          :label="field.label"
          :help="field.help"
          required
        >
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="adm-input"
            :value="values[field.key]"
            :maxlength="field.maximum"
            required
            @input="change(field.key, $event)"
          />
        </AdminFormField>
        <AdminFormField
          v-for="field in unitFields"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          :label="field.label"
          :required="!field.nullable"
        >
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="adm-input"
            type="number"
            inputmode="decimal"
            :value="values[field.key] ?? ''"
            :min="field.minimum"
            :step="field.decimal ? 'any' : 1"
            :required="!field.nullable"
            @input="change(field.key, $event, true, field.nullable)"
          />
        </AdminFormField>
      </div>
    </fieldset>
    <fieldset :disabled="disabled" class="adm-stack">
      <legend class="adm-section__title">Impuestos y envío</legend>
      <div class="adm-form-grid">
        <AdminFormField :for="`${prefix}-taxClassId`" label="Tipo de IVA" required>
          <select
            :id="`${prefix}-taxClassId`"
            data-field="taxClassId"
            class="adm-input"
            :value="values.taxClassId"
            required
            @change="change('taxClassId', $event)"
          >
            <option value="">Elige una opción</option>
            <option v-for="entry in options.taxClasses" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
          </select>
        </AdminFormField>
        <AdminFormField :for="`${prefix}-shippingProfileId`" label="Perfil de envío" required>
          <select
            :id="`${prefix}-shippingProfileId`"
            data-field="shippingProfileId"
            class="adm-input"
            :value="values.shippingProfileId"
            required
            @change="change('shippingProfileId', $event)"
          >
            <option value="">Elige una opción</option>
            <option v-for="entry in options.shippingProfiles" :key="entry.id" :value="entry.id">
              {{ entry.name }}
            </option>
          </select>
        </AdminFormField>
        <AdminFormField
          v-for="field in logisticsFields"
          :key="field.key"
          :for="`${prefix}-${field.key}`"
          :label="field.label"
          :required="!field.nullable"
        >
          <input
            :id="`${prefix}-${field.key}`"
            :data-field="field.key"
            class="adm-input"
            type="number"
            inputmode="numeric"
            :value="values[field.key] ?? ''"
            :min="field.minimum"
            step="1"
            :required="!field.nullable"
            @input="change(field.key, $event, true, field.nullable)"
          />
        </AdminFormField>
      </div>
      <label :for="`${prefix}-backorderAllowed`" class="adm-check">
        <input
          :id="`${prefix}-backorderAllowed`"
          data-field="backorderAllowed"
          type="checkbox"
          :checked="values.backorderAllowed === true"
          @change="change('backorderAllowed', $event)"
        />
        Permitir pedidos aunque no queden existencias
      </label>
    </fieldset>
  </div>
</template>
