import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'
import { dispatchNitroD1Request, isD1ApiPath } from '../../workers/runtime/nitro-bridge'
import type { NitroCloudflarePlatform } from '../../workers/runtime/nitro-bridge'

export default defineEventHandler(async (event) => {
  if (!isD1ApiPath(event.path.split('?')[0]!)) return
  const response = await dispatchNitroD1Request(
    toWebRequest(event),
    event.context.cloudflare as NitroCloudflarePlatform | undefined
  )
  if (response) return sendWebResponse(event, response)
})
