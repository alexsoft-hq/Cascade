import { service } from './service'

function send(cfg) {
  return service(cfg)
}

// The same shape held in a named const instead of the default export, and
// written as methods rather than arrows.
export const http = {
  fetch(option) {
    return send({ method: 'GET', ...option })
  },
  remove(option) {
    return send({ method: 'DELETE', ...option })
  }
}

// A caller in the SAME file as the object.
export function listPlain() {
  return http.fetch({ url: '/plain/list' })
}

// The same object again as the module's default: a name that holds it.
export default http
