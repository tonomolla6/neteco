<script setup lang="ts">
/** SEO-031: public authorship, technical review and evidence. Renders only server-verified data. */
import { ref, onMounted } from 'vue'
import { serializeJsonLd } from '~~/shared/content-governance'

interface Person {
  name: string
  bio: string
  experience: string
  credentials: string | null
}
interface Source {
  label: string
  url: string
  kind: string
}
interface Trust {
  author: Person
  reviewer: Person
  sources: Source[]
  claims: Array<{ text: string; category: string; evidence: Source }>
  lastReviewedAt: string
  nextReviewAt: string
  jsonLd: Record<string, unknown>
}
const props = defineProps<{ slug: string }>()
const request = useRequestFetch()
const trust = ref<Trust | null>(null)
const CATEGORY: Record<string, string> = { chemical: 'Química', health: 'Sanitaria', commercial: 'Comercial' }

async function load() {
  trust.value = null
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(props.slug)) return
  try {
    const result = await request<Trust>(`/api/content-trust/${props.slug}`, { method: 'GET' })
    trust.value = result
  } catch (error) {
    const failure = error as { statusCode?: number; data?: { redirectTo?: unknown } }
    const target = failure.data?.redirectTo
    if (failure.statusCode === 410 && typeof target === 'string' && /^\/(?!\/)[A-Za-z0-9\-._~/]*$/.test(target))
      await navigateTo(target, { redirectCode: 301 })
  }
}
useHead(() => ({
  script: trust.value ? [{ type: 'application/ld+json', innerHTML: serializeJsonLd(trust.value.jsonLd) }] : []
}))
onMounted(load)
</script>

<template>
  <aside
    v-if="trust"
    class="mx-auto max-w-3xl space-y-4 p-4 text-sm"
    data-testid="content-trust"
    aria-labelledby="trust-title"
  >
    <h2 id="trust-title" class="text-lg font-semibold">Autoría y revisión técnica</h2>
    <div class="grid gap-4 sm:grid-cols-2">
      <section>
        <h3 class="font-medium">Autoría</h3>
        <p>{{ trust.author.name }}</p>
        <p>{{ trust.author.bio }}</p>
        <p>{{ trust.author.experience }}</p>
        <p v-if="trust.author.credentials">{{ trust.author.credentials }}</p>
      </section>
      <section>
        <h3 class="font-medium">Revisión técnica</h3>
        <p>{{ trust.reviewer.name }}</p>
        <p>{{ trust.reviewer.experience }}</p>
        <p v-if="trust.reviewer.credentials">{{ trust.reviewer.credentials }}</p>
      </section>
    </div>
    <p>Última revisión: {{ trust.lastReviewedAt.slice(0, 10) }} · Próxima revisión: {{ trust.nextReviewAt }}</p>
    <section v-if="trust.claims.length">
      <h3 class="font-medium">Afirmaciones y evidencia</h3>
      <ul class="list-disc pl-5">
        <li v-for="claim in trust.claims" :key="claim.text">
          {{ claim.text }} ({{ CATEGORY[claim.category] }}) —
          <a :href="claim.evidence.url" rel="noopener noreferrer nofollow" target="_blank">{{
            claim.evidence.label
          }}</a>
        </li>
      </ul>
    </section>
    <section v-if="trust.sources.length">
      <h3 class="font-medium">Fuentes</h3>
      <ul class="list-disc pl-5">
        <li v-for="source in trust.sources" :key="source.url">
          <a :href="source.url" rel="noopener noreferrer nofollow" target="_blank">{{ source.label }}</a>
        </li>
      </ul>
    </section>
  </aside>
</template>
