import { structuredLog } from '../utils/log'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, context) => {
    structuredLog('error', 'application.error', {
      correlationId: context.event?.context.correlationId,
      method: context.event?.method,
      path: context.event ? getRequestURL(context.event).pathname : undefined,
      errorName: error.name,
      statusCode: 'statusCode' in error ? error.statusCode : 500
    })
  })
})
