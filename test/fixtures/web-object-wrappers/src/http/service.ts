import axios from 'axios'

// The one place the library is touched. No base URL, so what a call writes is
// what the server is asked for.
export const service = axios.create({ timeout: 5000 })
