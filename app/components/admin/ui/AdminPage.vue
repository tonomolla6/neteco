<script setup lang="ts">
/**
 * Cabecera y cuerpo únicos de todas las pantallas del panel.
 *
 * El título, la descripción, las migas y las pestañas salen del árbol de navegación
 * (`shared/admin-navigation.ts`) según la ruta: ninguna pantalla vuelve a escribir su
 * propio bloque de título. Las acciones principales van siempre arriba a la derecha.
 */
import { adminNavigationLocate } from '~~/shared/admin-navigation'

const props = defineProps<{
  /** Sustituye al título de la sección (p. ej. el número de un pedido en su detalle). */
  title?: string
  description?: string
  count?: number | string
  countLabel?: string
  /** Enlace «volver» para pantallas de detalle. */
  back?: { to: string; label: string }
}>()

const route = useRoute()
const navigation = useAdminNavigation()
const located = computed(() => adminNavigationLocate(route.path, navigation.tree.value, route.fullPath))
const tabs = computed(() => (props.back ? [] : (located.value?.item.tabs ?? [])))
const heading = computed(() => props.title ?? located.value?.item.label ?? 'Panel')
const summary = computed(() => props.description ?? located.value?.tab.description)
const crumbs = computed(() => {
  const found = located.value
  if (!found) return []
  const list: Array<{ label: string; to?: string }> = []
  if (found.section.label !== found.item.label) list.push({ label: found.section.label })
  const inner = props.back || found.item.tabs.length > 1
  list.push({ label: found.item.label, ...(inner ? { to: found.item.tabs[0]!.to } : {}) })
  if (props.back) list.push({ label: props.title ?? 'Detalle' })
  else if (found.item.tabs.length > 1) list.push({ label: found.tab.label })
  return list
})
useHead(() => ({ title: `${props.title ?? located.value?.tab.label ?? heading.value} · Panel NETECO` }))
</script>

<template>
  <div class="adm-page">
    <header class="adm-page__head">
      <nav v-if="crumbs.length > 1" aria-label="Ubicación en el panel" class="adm-page__crumbs">
        <ol data-breadcrumbs>
          <li v-for="(crumb, index) in crumbs" :key="index">
            <NuxtLink v-if="crumb.to && index < crumbs.length - 1" :to="crumb.to">{{ crumb.label }}</NuxtLink>
            <span v-else :aria-current="index === crumbs.length - 1 ? 'page' : undefined">{{ crumb.label }}</span>
          </li>
        </ol>
      </nav>
      <div class="adm-page__bar">
        <div class="min-w-0">
          <NuxtLink v-if="back" :to="back.to" class="adm-page__back">
            <UIcon name="i-lucide-arrow-left" class="size-4" />{{ back.label }}
          </NuxtLink>
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 class="adm-page__title">{{ heading }}</h1>
            <span v-if="count !== undefined" class="adm-page__count">
              {{ countLabel ? `${count} ${countLabel}` : count }}
            </span>
            <slot name="title-extra" />
          </div>
          <p v-if="summary" class="adm-page__summary">{{ summary }}</p>
        </div>
        <div class="adm-page__actions">
          <slot name="actions" />
          <!-- Destino de AdminPageActions: acciones declaradas desde un componente interior. -->
          <div id="adm-page-actions" class="contents" />
        </div>
      </div>
      <nav v-if="tabs.length > 1" class="adm-tabs adm-page__tabs" :aria-label="`Apartados de ${located?.item.label}`">
        <NuxtLink
          v-for="entry in tabs"
          :key="entry.to"
          :to="entry.to"
          class="adm-tab"
          :aria-current="entry === located?.tab ? 'page' : undefined"
        >
          {{ entry.label }}
        </NuxtLink>
      </nav>
    </header>
    <div class="adm-body">
      <slot />
    </div>
  </div>
</template>
