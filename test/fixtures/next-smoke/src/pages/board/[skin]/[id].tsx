import axios from 'axios'

export async function loadPost(id: string) {
  return axios.get(`/api/v1/posts/${id}`)
}

export default function Post() {
  return null
}
