import axios from 'axios'
import { COMMENTS_URL, Paths } from './urls'
import * as Urls from './urls'

// The same shape written across two files. One file cannot say what another
// exports, so these stay holes here and carry the specifier that leads to it.
export const listComments = (postsNo: number) => axios.get(`${COMMENTS_URL}/of/${postsNo}`)

export const listBoardComments = (boardNo: number) => axios.get(`${Paths.boards}/${boardNo}/comments`)

export const countComments = (boardNo: number) => axios.get(`${Urls.COMMENTS_URL}/count/${boardNo}`)
