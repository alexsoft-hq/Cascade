import client from '@/utils/http'

enum CatalogUrls {
  list = '/catalog/list',
  save = '/catalog/save',
  edit = '/catalog/edit',
}

export const listCatalog = (p) => client.get({ url: CatalogUrls.list, params: p })

export const storeCatalog = (p, isNew) => {
  const url = isNew ? CatalogUrls.save : CatalogUrls.edit
  return client.post({ url, params: p })
}

export const fetchWhereverTheCallerSays = (where, p) => client.get({ url: where, params: p })
