import request from '../http'
import { http } from '../http/named'
import held from '../http/named'

export const listThings = (params) => request.get({ url: '/things/list', params })

export const saveThing = (data) => request.post({ url: '/things/save', data })

export const replaceThing = (data) => request.put({ url: '/things/save', data })

// The caller names its own method, and the wrapper spreads the caller's options
// after its own, so this is a POST.
export const saveThingThroughGet = (data) => request.get({ url: '/things/save', method: 'post', data })

// The caller's options carry a spread of their own, so nothing here says
// whether they name a method.
export const listWithConfig = (config) => request.get({ ...config, url: '/things/list' })

// The URL is in the argument `query` does not hand on.
export const listThroughQuery = () => request.query({ url: '/things/list' }, {})

export const removePlain = () => http.remove({ url: '/plain/list' })

export const listHeld = () => held.fetch({ url: '/plain/list' })
