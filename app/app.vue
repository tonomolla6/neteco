<script setup lang="ts">
// Splash de carga: cubre la página hasta que está hidratada (botones respondiendo)
// y se desvanece entonces. Evita clics muertos durante la carga inicial.
// Las navegaciones posteriores entre páginas usan la barra fina superior.
const hydrated = useHydrated()
onMounted(() => {
  // doble rAF: deja que la app pinte bajo el splash antes de desvanecerlo
  requestAnimationFrame(() => requestAnimationFrame(() => (hydrated.value = true)))
})
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <NuxtLoadingIndicator color="#009ac9" :height="3" />
    <Transition name="splash">
      <div
        v-if="!hydrated"
        class="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-5 bg-white"
        aria-label="Cargando NETECO…"
      >
        <div class="splash-pop flex flex-col items-center gap-4">
          <img src="/logo-figura.png" alt="" class="splash-bob h-20 w-auto" >
          <img src="/logo-texto.png" alt="NETECO" class="h-8 w-auto" >
        </div>
        <div class="mt-2 flex gap-2" aria-hidden="true">
          <span class="splash-dot size-2.5 rounded-full bg-neteco-500" />
          <span class="splash-dot size-2.5 rounded-full bg-neteco-500" style="animation-delay: 0.15s" />
          <span class="splash-dot size-2.5 rounded-full bg-neteco-500" style="animation-delay: 0.3s" />
        </div>
      </div>
    </Transition>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<style>
/* entrada suave del logo */
@keyframes splash-pop {
  0% {
    opacity: 0;
    transform: scale(0.92);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}
.splash-pop {
  animation: splash-pop 0.45s ease-out both;
}
/* flotación de la figura (gota de agua) */
@keyframes splash-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-8px);
  }
}
.splash-bob {
  animation: splash-bob 1.6s ease-in-out infinite;
}
/* puntos rebotando escalonados */
@keyframes splash-dot {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-7px);
    opacity: 1;
  }
}
.splash-dot {
  animation: splash-dot 1s ease-in-out infinite;
}
/* desvanecido al terminar: la página aparece ya interactiva */
.splash-leave-active {
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;
}
.splash-leave-to {
  opacity: 0;
  transform: scale(1.04);
}
</style>
