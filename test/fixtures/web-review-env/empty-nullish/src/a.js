import axios from 'axios';
const client = axios.create({ baseURL: import.meta.env.VITE_BASE ?? 'http://localhost:8080/api' });
export function go() { return client.get('/things'); }
