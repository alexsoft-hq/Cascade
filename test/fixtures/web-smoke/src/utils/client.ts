import axios from 'axios'

// A client written as a CLASS, which is the other half of how frontends wrap
// HTTP: the library instance lives on a field, the verb methods forward to one
// generic method, and that method is the only place the library is touched.
export class Client {
  private inner

  constructor(options) {
    this.inner = axios.create({ baseURL: '/dev-prefix', ...options })
  }

  get(config) {
    return this.request({ ...config, method: 'GET' })
  }

  post(config) {
    return this.request({ ...config, method: 'POST' })
  }

  request(config) {
    return this.inner.request(config)
  }
}
