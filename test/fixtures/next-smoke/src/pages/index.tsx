import axios from 'axios'

export async function loadHome() {
  return axios.get('/api/v1/home')
}

export default function Home() {
  return null
}
