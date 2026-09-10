import axios from 'axios'

// The commonest shape there is: the path is a constant at the top of the file,
// and every call is that constant plus what the caller passes.
const POSTS_URL = '/board-service/api/v1/posts'

export const postService = {
  getPost: (postsNo: number) => axios.get(`${POSTS_URL}/${postsNo}`),
  savePost: (data: unknown) => axios.post(`${POSTS_URL}/save`, data),
}
