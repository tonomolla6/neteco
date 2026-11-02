<script setup lang="ts">
import type { AdminNavigationLink } from '~~/shared/admin-navigation'
const props = defineProps<{
  groups: Array<{ label: string; links: AdminNavigationLink[] }>
  path: string
  scopeKey: string
  enabled: boolean
  pending?: boolean
}>()

// Only canonical supplied destinations are retained; never a detail identifier,
// query, fragment, identity or customer label. This memory belongs to this mount.
const history = ref<string[]>([])
const destinations = computed(() => {
  if (props.pending || !props.enabled || !props.scopeKey) return []
  const seen = new Set<string>()
  return props.groups.flatMap((group) =>
    group.links
      .filter((link) => {
        if (!/^\/admin(?:\/[a-z][a-z-]*)*$/u.test(link.to) || seen.has(link.to)) return false
        seen.add(link.to)
        return true
      })
      .map((link) => ({ ...link, category: group.label }))
  )
})
const currentPath = computed(() => {
  const path = props.path.split(/[?#]/u)[0] ?? ''
  if (
    [...path].some((character) => character.charCodeAt(0) <= 32) ||
    path.includes('\\') ||
    /%2f|%5c|%2e/iu.test(path) ||
    path.includes('//')
  )
    return ''
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return ''
  return path.replace(/\/$/u, '')
})
const current = computed(
  () =>
    destinations.value
      .filter(
        (link) =>
          currentPath.value === link.to ||
          (!link.exact && link.to !== '/admin' && currentPath.value.startsWith(`${link.to}/`))
      )
      .sort((a, b) => b.to.length - a.to.length)[0]
)
const home = computed(() => destinations.value.find((link) => link.to === '/admin'))
const detail = computed(() => !!current.value && currentPath.value !== current.value.to)
const recent = computed(() =>
  history.value.flatMap((to) => {
    const destination = destinations.value.find((link) => link.to === to)
    return destination ? [destination] : []
  })
)

watch(
  [() => props.scopeKey, destinations, current, () => props.pending],
  ([scope, allowed, selected, pending], previous) => {
    if (scope !== previous?.[0]) history.value = []
    // A same-session capability refresh hides all links, but is not revocation.
    // Recheck the saved canonical destinations against fresh grants before reveal.
    if (pending) return
    if (!props.enabled || !allowed.length) history.value = []
    history.value = history.value.filter((to) => allowed.some((link) => link.to === to))
    if (selected) history.value = [selected.to, ...history.value.filter((to) => to !== selected.to)].slice(0, 5)
  },
  // Batch the parent's capability props atomically; DOM gates above remain
  // immediate, while reconciliation runs before rendering the ready state.
  { immediate: true, flush: 'pre' }
)
</script>
<template>
  <div v-if="destinations.length" class="min-w-0 max-w-full space-y-3">
    <nav v-if="current" aria-label="Ubicación administrativa" class="min-w-0">
      <p class="text-xs text-muted">{{ current.category }}</p>
      <ol data-breadcrumbs class="flex min-w-0 flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]">
        <li v-if="home && home.to !== current.to">
          <NuxtLink :to="home.to" class="underline focus-visible:outline-2">{{ home.label }}</NuxtLink>
          <span aria-hidden="true" class="ml-2">/</span>
        </li>
        <li v-if="detail">
          <NuxtLink :to="current.to" class="underline focus-visible:outline-2">{{ current.label }}</NuxtLink>
          <span aria-hidden="true" class="ml-2">/</span>
        </li>
        <li>
          <span aria-current="page">{{ detail ? 'Detalle' : current.label }}</span>
        </li>
      </ol>
    </nav>
    <nav v-if="recent.length" data-recent aria-label="Páginas visitadas en este panel" class="min-w-0">
      <p class="text-xs text-muted">Páginas visitadas en este panel</p>
      <ul class="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-sm [overflow-wrap:anywhere]">
        <li v-for="link in recent" :key="link.to">
          <NuxtLink :to="link.to" class="underline focus-visible:outline-2">{{ link.label }}</NuxtLink>
        </li>
      </ul>
    </nav>
  </div>
</template>
