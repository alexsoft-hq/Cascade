import { api } from '@/utils/all'

export function getOrder(id) {
  return api.get({ url: '/orders/' + id })
}
