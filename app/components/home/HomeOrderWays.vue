<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Atajos de pedido para quien repone: referencia, listas, repetir y teléfono.
 *
 * Sustituye al bloque «Como te venga mejor», tres iconos con un botón gris cada uno. Aquí
 * cada atajo se puede usar en el sitio: el buscador por referencia añade al carrito desde
 * la propia portada, y las listas enseñan productos reales del catálogo.
 */
const props = defineProps<{ samples: ProductCardData[] }>()

const { terms, phone, email } = useCommercialTerms()
const LISTS_PATH = '/cuenta/listas'
const teamPhoto = computed(() => homeImage('equipo-atencion-telefonica'))
const listSamples = computed(() => props.samples.filter((product) => product.image).slice(0, 3))
</script>

<template>
  <section aria-labelledby="home-order-ways" class="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 sm:py-10">
    <h2 id="home-order-ways" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">
      Haz tu pedido en menos tiempo
    </h2>
    <p class="mt-1 text-[15px] text-[var(--text-muted)]">Atajos pensados para quien compra lo mismo cada semana.</p>

    <div class="mt-5 grid gap-3 sm:gap-4 lg:grid-cols-3">
      <!-- Por referencia, aquí mismo -->
      <div
        data-home-order-reference
        class="rounded-[var(--radius-panel)] bg-neteco-900 p-5 text-white sm:p-8 lg:col-span-2"
      >
        <p class="font-display text-2xl font-bold leading-tight text-white sm:text-3xl">¿Ya sabes lo que necesitas?</p>
        <p class="mt-2 max-w-xl text-[15px] text-neteco-100 sm:text-base">
          Pide por referencia en un minuto. Escribe el código o el nombre y añádelo al carrito sin salir de aquí.
        </p>
        <div class="mt-5 max-w-xl text-[var(--text)]">
          <SearchBox prominent size="xl" placeholder="Referencia o nombre del producto" />
        </div>
        <NuxtLink
          to="/pedido-rapido"
          class="mt-4 inline-flex items-center gap-1.5 text-[15px] font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white"
        >
          ¿Son muchas referencias? Pega tu lista entera en el pedido rápido
          <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0" />
        </NuxtLink>
      </div>

      <!-- Listas -->
      <NuxtLink
        :to="LISTS_PATH"
        class="group flex flex-col rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 transition hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-overlay)] sm:p-6"
      >
        <div v-if="listSamples.length" aria-hidden="true" class="mb-4 flex -space-x-3">
          <div
            v-for="product in listSamples"
            :key="product.id"
            class="size-16 overflow-hidden rounded-[var(--radius-surface)] border-2 border-white bg-white shadow-[var(--shadow-raised)] [&_img]:rounded-none [&_img]:border-0"
          >
            <ProductImage :product="{ ...product, imageAlt: '' }" sizes="64px" />
          </div>
        </div>
        <UIcon v-else name="i-lucide-list-checks" class="mb-4 size-8 text-[var(--text-muted)]" aria-hidden="true" />
        <p class="font-display text-lg font-bold text-[var(--text-strong)] group-hover:text-[var(--link)]">
          Tus listas de siempre
        </p>
        <p class="mt-1 text-[15px] text-[var(--text)]">
          Guarda lo que pides cada semana para la cocina, la limpieza o cada local, y añádelo al carrito de una vez.
        </p>
        <span class="mt-auto pt-4 text-[15px] font-semibold text-[var(--link)]">Ver mis listas</span>
      </NuxtLink>

      <!-- Repetir -->
      <NuxtLink
        to="/cuenta/pedidos"
        class="group flex flex-col rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5 transition hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-overlay)] sm:p-6"
      >
        <UIcon name="i-lucide-rotate-cw" class="mb-4 size-8 text-[var(--text-muted)]" aria-hidden="true" />
        <p class="font-display text-lg font-bold text-[var(--text-strong)] group-hover:text-[var(--link)]">
          Repite un pedido anterior
        </p>
        <p class="mt-1 text-[15px] text-[var(--text)]">
          Vuelve a pedir lo de la última vez con un toque y cambia solo las cantidades que hagan falta.
        </p>
        <span class="mt-auto pt-4 text-[15px] font-semibold text-[var(--link)]">Ver mis pedidos</span>
      </NuxtLink>

      <!-- Hablar con una persona -->
      <div
        class="grid overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] sm:grid-cols-[2fr_3fr] lg:col-span-2"
      >
        <div class="relative min-h-44 bg-neteco-50">
          <img
            v-if="teamPhoto"
            :src="teamPhoto.src"
            :alt="teamPhoto.alt"
            :width="teamPhoto.width"
            :height="teamPhoto.height"
            loading="lazy"
            class="absolute inset-0 h-full w-full object-cover"
          />
          <div v-else class="flex h-full items-center justify-center">
            <UIcon name="i-lucide-headset" class="size-14 text-neteco-700" aria-hidden="true" />
          </div>
        </div>
        <div class="flex flex-col justify-center p-5 sm:p-6">
          <p class="font-display text-lg font-bold text-[var(--text-strong)]">
            ¿Prefieres que te lo preparemos nosotros?
          </p>
          <p class="mt-1 text-[15px] text-[var(--text)]">
            {{ phone ? 'Llámanos' : 'Escríbenos' }}
            <template v-if="terms.supportHours">{{ terms.supportHours }}</template>
            y te tomamos el pedido, o te aconsejamos el producto y la dosis.
          </p>
          <div class="mt-4 flex flex-wrap gap-2">
            <UButton v-if="phone" :to="phone.href" icon="i-lucide-phone" size="lg">{{ phone.display }}</UButton>
            <UButton
              :to="`mailto:${email}`"
              icon="i-lucide-mail"
              size="lg"
              :color="phone ? 'neutral' : 'primary'"
              :variant="phone ? 'outline' : 'solid'"
            >
              {{ phone ? 'Escribir un correo' : email }}
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
