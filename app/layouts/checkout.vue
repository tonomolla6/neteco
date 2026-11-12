<script setup lang="ts">
/**
 * Maqueta del pago. En el último paso cada enlace es una salida: fuera el buscador, las
 * familias, el boletín y la barra inferior. Quedan el camino de vuelta al carrito, la señal
 * de pago seguro y el teléfono, que es lo que alguien busca cuando duda antes de pagar.
 */
const { phone: contactPhone, email: contactEmail } = useCommercialTerms()
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <a
      href="#contenido-principal"
      class="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white shadow-lg transition focus:translate-y-0"
    >
      Saltar al contenido
    </a>
    <header class="border-b border-[var(--border)] bg-[var(--surface)]">
      <div class="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3">
        <NuxtLink to="/carrito" aria-label="NETECO. Volver al carrito" class="flex shrink-0 items-center gap-2">
          <img src="/logo-figura.svg" alt="" width="34" height="36" class="h-9 w-auto" />
          <img src="/logo-texto.svg" alt="" width="140" height="24" class="hidden h-6 w-auto sm:block" />
        </NuxtLink>
        <p class="flex items-center gap-1.5 text-[15px] font-medium text-[var(--text-strong)]">
          <UIcon name="i-lucide-lock" class="size-4 text-[var(--text-muted)]" /> Pago seguro
        </p>
        <a
          v-if="contactPhone"
          :href="contactPhone.href"
          class="flex min-h-11 items-center gap-1.5 text-[15px] font-medium text-[var(--text-strong)] hover:underline"
        >
          <UIcon name="i-lucide-phone" class="size-4 text-[var(--text-muted)]" /> {{ contactPhone.display }}
        </a>
        <a
          v-else
          :href="`mailto:${contactEmail}`"
          class="flex min-h-11 min-w-0 items-center gap-1.5 text-[15px] font-medium text-[var(--text-strong)] hover:underline"
        >
          <UIcon name="i-lucide-mail" class="size-4 shrink-0 text-[var(--text-muted)]" />
          <span class="truncate">{{ contactEmail }}</span>
        </a>
      </div>
    </header>
    <main id="contenido-principal" class="flex-1" tabindex="-1">
      <slot />
    </main>
    <footer class="border-t border-[var(--border)] bg-[var(--surface)]">
      <p class="mx-auto max-w-[1600px] px-4 py-4 text-[13px] text-[var(--text-muted)]">
        NETECO · Ontinyent ·
        <a href="/condiciones-generales" target="_blank" rel="noopener" class="underline">Condiciones de venta</a>
        ·
        <a href="/privacidad" target="_blank" rel="noopener" class="underline">Privacidad</a>
        ·
        <a href="/cookies" target="_blank" rel="noopener" class="underline">Cookies</a>
        ·
        <a href="/aviso-legal" target="_blank" rel="noopener" class="underline">Aviso legal</a>
      </p>
    </footer>
    <ConsentManager />
  </div>
</template>
