import { api } from '@/utils/factory'
import { helper } from 'some-other-http-lib'

export function listItems(params) {
  return api.get({ url: '/v/items', params })
}

export function itemsElsewhere() {
  return api.get({ url: 'https://elsewhere.example.com/v/items' })
}

// `helper` comes from a package this analysis never reads, so nothing here can
// show that this call sends anything: the URL is a URL, and that is all.
export function sendThing(body) {
  return helper.post('/u/thing', body)
}
