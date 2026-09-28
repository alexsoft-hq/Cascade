// Every way this fixture writes a base URL the BUILD decides.
export const SERVER_URL = process.env.SHOP_SERVER_URL || 'http://localhost:8080/api';

export const settings = {
  baseUrl: import.meta.env.VITE_ORIGIN + import.meta.env.VITE_API_PATH,
  timeout: 'long',
};

export const PICKED = import.meta.env.MODE === 'production' ? import.meta.env.VITE_ORIGIN : '/';

export const PLAIN = import.meta.env.VITE_PLAIN;
