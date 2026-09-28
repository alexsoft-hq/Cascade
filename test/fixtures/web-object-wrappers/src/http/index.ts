import { service } from './service'

// A helper the object's methods all go through. It takes a few keys out and
// hands the rest to the client, the way a real one adds its headers.
const request = (option: any) => {
  const { headersType, ...rest } = option
  return service({ ...rest })
}

// THE WRAPPER IS AN OBJECT. Each method writes its verb BEFORE the caller's
// options, so a caller that names a method of its own replaces it; `put`
// writes it after, so nothing a caller hands in replaces that one.
export default {
  get: async <T = any>(option: any) => {
    const res = await request({ method: 'GET', ...option })
    return res.data as unknown as T
  },
  post: async (option: any) => {
    const res = await request({ method: 'POST', ...option })
    return res.data
  },
  put: (option: any) => request({ ...option, method: 'PUT' }),
  // Hands on its SECOND argument, so a URL the caller writes in the first
  // never reaches the client.
  query: (option: any, extra: any) => request({ method: 'GET', ...extra }),
  // Calls the helper and hands it nothing it was given: not a forward.
  ping: () => {
    const cfg = { method: 'GET' }
    return request(cfg)
  }
}
