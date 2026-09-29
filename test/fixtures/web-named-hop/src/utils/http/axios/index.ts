// The template's transform (vue-vben-admin's src/utils/http/axios/index.ts),
// trimmed: the hook puts the prefix the request options name before the URL,
// appends text params to it, and adds a timestamp.
import { ApiClient } from './Axios';

const transform = {
  beforeRequestHook: (config, options) => {
    const { apiUrl, joinPrefix, urlPrefix, joinTime = true } = options;
    if (joinPrefix) {
      config.url = `${urlPrefix}${config.url}`;
    }
    if (apiUrl && typeof apiUrl === 'string') {
      config.url = `${apiUrl}${config.url}`;
    }
    const params = config.params || {};
    if (typeof params !== 'string') {
      config.params = Object.assign(params || {}, joinTime ? { _t: Date.now() } : {});
    } else {
      config.url = config.url + params;
      config.params = undefined;
    }
    return config;
  },
  requestInterceptors: (config) => {
    config.headers.Authorization = 'token';
    return config;
  },
};

function createClient(opt?: any) {
  return new ApiClient({
    timeout: 10000,
    transform,
    requestOptions: {
      joinPrefix: true,
      apiUrl: '/basic-api',
      urlPrefix: '',
      joinTime: true,
    },
    ...(opt || {}),
  });
}

export const http = createClient();
