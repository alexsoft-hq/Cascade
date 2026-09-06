import client from '@/utils/http'

export function listThings(query) {
  return client({
    url: '/things/list',
    method: 'get',
    params: query
  })
}

export function detailThing(id) {
  return client({
    url: '/things/' + id,
    method: 'get'
  })
}

export function thingTags(id) {
  return client({
    url: `/things/${id}/tags`,
    method: 'get'
  })
}

export function saveThing(data) {
  return client({
    url: '/things/save',
    data
  })
}
