import axios from 'axios';
const client = axios.create({ baseURL: import.meta.env.VITE_BASE });
export function go() { return client.get('/things'); }
