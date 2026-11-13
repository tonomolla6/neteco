<script setup lang="ts">
/**
 * Grupo de ajustes en solo lectura, al estilo de una pantalla de «Ajustes» de WordPress o
 * PrestaShop: nombre y explicación a la izquierda, valor en vigor a la derecha.
 * Un valor vacío se enseña como «Sin configurar»; nunca se pinta un secreto.
 */
export interface AdminSetting {
  label: string
  /** Texto en vigor. Vacío o nulo: «Sin configurar». */
  value?: string | number | null
  help?: string
  /** Interruptor: se pinta como «Activado» / «Desactivado» en vez de texto. */
  enabled?: boolean | null
  /** Etiquetas alternativas para un interruptor (p. ej. «Pruebas» / «Real»). */
  badge?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
  /** Nombre de la variable de entorno donde se cambia. */
  variable?: string
  /** No es un fallo que falte: se enseña «No indicado» en gris en vez de «Sin configurar». */
  optional?: boolean
}
defineProps<{ title: string; description?: string; items: AdminSetting[]; loading?: boolean }>()
const blank = (item: AdminSetting) => item.value === undefined || item.value === null || item.value === ''
</script>

<template>
  <AdminCard :title="title" :description="description" flush>
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <dl class="adm-settings" :aria-busy="loading || undefined">
      <div v-for="item in items" :key="item.label" class="adm-settings__row">
        <dt>
          <span class="adm-settings__label">{{ item.label }}</span>
          <span v-if="item.help" class="adm-settings__help">{{ item.help }}</span>
        </dt>
        <dd>
          <span v-if="loading" class="adm-settings__skeleton" />
          <AdminBadge v-else-if="item.badge" :tone="item.badge.tone">{{ item.badge.label }}</AdminBadge>
          <AdminBadge
            v-else-if="item.enabled !== undefined && item.enabled !== null"
            :tone="item.enabled ? 'success' : 'neutral'"
          >
            {{ item.enabled ? 'Activado' : 'Desactivado' }}
          </AdminBadge>
          <AdminBadge v-else-if="item.enabled === null" tone="neutral">Sin datos</AdminBadge>
          <span v-else-if="!blank(item)" class="adm-settings__value">{{ item.value }}</span>
          <span v-else-if="item.optional" class="adm-settings__missing">No indicado</span>
          <AdminBadge v-else tone="warning">Sin configurar</AdminBadge>
          <code
            v-if="item.variable"
            class="adm-settings__variable"
            :title="'Se cambia en la variable de entorno ' + item.variable"
          >
            <template v-for="(part, index) in item.variable.split('_')" :key="index"
              ><template v-if="index">_<wbr /></template>{{ part }}</template
            >
          </code>
        </dd>
      </div>
    </dl>
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </AdminCard>
</template>
