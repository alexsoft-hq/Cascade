import axios from 'axios';
import { settings, SERVER_URL } from './settings';

const { baseUrl } = settings;

export const client = axios.create({ baseURL: baseUrl });

export function renewToken(token) {
  return axios.post(baseUrl + '/auth/renew?token=' + token);
}

export function listOrders() {
  return fetch(SERVER_URL + '/orders');
}

export function inlineDefault(id) {
  return fetch((process.env.SHOP_SERVER_URL || '/api') + '/orders/' + id);
}

export function readCache(cache, name) {
  return cache.get(name || 'fallback-key');
}
