import axios from 'axios'

const ROOT = '/report-service'
const V1 = `${ROOT}/api/v1`
const REPORTS_URL = `${V1}/reports`

// A deployment's own value, not this repository's, so it is never filled in.
const HOST = process.env.REPORT_HOST
const EXTERNAL_URL = `${HOST}/reports`

// Deliberately circular. It is not code that runs; it is here so that a reader
// which follows one name to the next has to stop somewhere.
const LOOP_A = `${LOOP_B}/a`
const LOOP_B = `${LOOP_A}/b`

const slug = (x: unknown) => String(x)

export const getReport = (id: number) => axios.get(`${REPORTS_URL}/${id}`)

export const getExternalReport = (id: number) => axios.get(`${EXTERNAL_URL}/${id}`)

export const getLoopedReport = (id: number) => axios.get(`${LOOP_A}/${id}`)

export const getReportRows = (id: number) => axios.get(`${V1}/${slug(id)}/rows`)

export const getFromTheEnvironment = (id: number) => axios.get(`${process.env.API_ROOT}/rows/${id}`)

// `let` is not a binding to the literal beside it: the next line assigns it
// again, and code like this is why only a `const` states a value.
export const getForTenant = (params: { tenant?: string }) => {
  let tenant = 'default'
  if (params.tenant) {
    tenant = params.tenant
  }
  return axios.get(`${REPORTS_URL}/of/${tenant}`)
}
