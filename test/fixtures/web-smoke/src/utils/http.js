import axios from 'axios'

const client = axios.create({
  baseURL: process.env.VUE_APP_BASE_API,
  timeout: 5000
})

client.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error)
)

client.interceptors.response.use(
  (response) => response.data,
  (error) => Promise.reject(error)
)

export default client
