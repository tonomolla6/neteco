import { revokeCurrentSession } from '../../utils/auth-session'
import { useDatabase } from '../../db/client'
import { hashAccessToken } from '../../utils/access-token'
import { hashOpaqueToken, randomOpaqueToken } from '../../utils/secrets'

export default defineEventHandler(async (event) => {
  const sql = useDatabase()
  const orderAccess = getCookie(event, 'neteco-order-access')
  const separator = orderAccess?.indexOf('.') ?? -1
  if (orderAccess && separator > 0) {
    const publicNumber = orderAccess.slice(0, separator)
    const token = orderAccess.slice(separator + 1)
    if (/^[A-Za-z0-9]{5,12}$/.test(publicNumber) && token) {
      await sql`
        UPDATE order_access_sessions access
        SET revoked_at = now()
        FROM orders purchase
        WHERE access.order_id = purchase.id
          AND purchase.public_number = ${publicNumber}
          AND access.token_hash = ${hashAccessToken(token)}
          AND access.revoked_at IS NULL
      `
    }
  }
  const cartToken = getCookie(event, 'neteco-cart')
  if (cartToken) {
    const tokenPepper = String(useRuntimeConfig(event).auth.tokenPepper)
    await sql`
      UPDATE carts
      SET public_token_hash = ${hashOpaqueToken(randomOpaqueToken(), tokenPepper)}, updated_at = now()
      WHERE public_token_hash = ${hashOpaqueToken(cartToken, tokenPepper)} AND status = 'active'
    `
  }
  await revokeCurrentSession(event)
  deleteCookie(event, 'neteco-order-access', { path: '/' })
  deleteCookie(event, 'neteco-cart', { path: '/' })
  return { ok: true }
})
