// A client class in vue-vben-admin's shape (its src/utils/http/axios/Axios.ts),
// under another name: the rule that names its `request` step reads the shape.
import type { AxiosRequestConfig, AxiosInstance } from 'axios';
import axios from 'axios';
import qs from 'qs';
import { cloneDeep } from 'lodash-es';

function isFunction(v: unknown) {
  return typeof v === 'function';
}

export class ApiClient {
  private axiosInstance: AxiosInstance;
  private readonly options: any;

  constructor(options: any) {
    this.options = options;
    this.axiosInstance = axios.create(options);
    this.setupInterceptors();
  }

  private getTransform() {
    const { transform } = this.options;
    return transform;
  }

  getAxios(): AxiosInstance {
    return this.axiosInstance;
  }

  private setupInterceptors() {
    const transform = this.getTransform();
    if (!transform) {
      return;
    }
    const { requestInterceptors } = transform;
    this.axiosInstance.interceptors.request.use((config: AxiosRequestConfig) => {
      if (requestInterceptors && isFunction(requestInterceptors)) {
        config = requestInterceptors(config, this.options);
      }
      return config;
    }, undefined);
  }

  uploadFile(config: AxiosRequestConfig, params: any) {
    const formData = new window.FormData();
    formData.append(params.name || 'file', params.file);
    config.baseURL = this.options.uploadUrl;
    return this.axiosInstance.request({
      ...config,
      method: 'POST',
      data: formData,
    });
  }

  supportFormData(config: AxiosRequestConfig) {
    const headers = config.headers || this.options.headers;
    const contentType = headers?.['Content-Type'] || headers?.['content-type'];
    if (contentType !== 'application/x-www-form-urlencoded' || !Reflect.has(config, 'data') || config.method?.toUpperCase() === 'GET') {
      return config;
    }
    return {
      ...config,
      data: qs.stringify(config.data, { arrayFormat: 'brackets' }),
    };
  }

  get(config: AxiosRequestConfig, options?: any) {
    return this.request({ ...config, method: 'GET' }, options);
  }

  post(config: AxiosRequestConfig, options?: any) {
    return this.request({ ...config, method: 'POST' }, options);
  }

  put(config: AxiosRequestConfig, options?: any) {
    return this.request({ ...config, method: 'PUT' }, options);
  }

  delete(config: AxiosRequestConfig, options?: any) {
    return this.request({ ...config, method: 'DELETE' }, options);
  }

  request(config: AxiosRequestConfig, options?: any) {
    let conf: any = cloneDeep(config);
    const transform = this.getTransform();
    const { requestOptions } = this.options;
    const opt = Object.assign({}, requestOptions, options);
    const { beforeRequestHook, transformRequestHook } = transform || {};
    if (beforeRequestHook && isFunction(beforeRequestHook)) {
      conf = beforeRequestHook(conf, opt);
    }
    conf.requestOptions = opt;
    conf = this.supportFormData(conf);
    return new Promise((resolve, reject) => {
      this.axiosInstance
        .request(conf)
        .then((res) => {
          if (transformRequestHook && isFunction(transformRequestHook)) {
            resolve(transformRequestHook(res, opt));
            return;
          }
          resolve(res);
        })
        .catch((e) => reject(e));
    });
  }
}
