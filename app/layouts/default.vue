<template>
  <div class="flex min-h-screen flex-col">
    <a
      href="#contenido-principal"
      class="fixed left-3 top-3 z-[100] -translate-y-20 rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white shadow-lg transition focus:translate-y-0"
    >
      Saltar al contenido
    </a>
    <AppHeader />
    <main id="contenido-principal" class="flex-1" tabindex="-1">
      <slot />
    </main>
    <AppFooter />
    <ConsentManager />
    <MarketingModalHost />
  </div>
</template>
