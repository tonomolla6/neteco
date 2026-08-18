export default defineEventHandler(() => ({
  status: 'ok',
  service: 'neteco',
  version: process.env.APP_VERSION ?? 'dev'
}))
