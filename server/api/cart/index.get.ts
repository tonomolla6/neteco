import { getServerCart } from '../../services/cart'

export default defineEventHandler((event) => getServerCart(event, true))
