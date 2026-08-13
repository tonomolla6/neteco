export default defineEventHandler((event) => {
  deleteCookie(event, 'neteco-analytics-id', { path: '/' })
  setResponseStatus(event, 204)
  return null
})
