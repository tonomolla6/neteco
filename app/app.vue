<template>
  <div class="font-sans text-slate-600 antialiased bg-slate-50 min-h-screen flex flex-col justify-between">
    <AppLoader />
    <div>
      <TopBar />
      <AppHeader />
      <main>
        <NuxtPage />
      </main>
    </div>
    <AppFooter />
  </div>
</template>

<style>
@import '~/assets/css/main.css';
</style>
