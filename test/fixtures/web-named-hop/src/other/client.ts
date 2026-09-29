// The same step in a class that is NOT the framework's shape (no
// supportFormData, no uploadFile): no rule names it, so its `request`, which
// hands a local it assigns again, stays unsettled.
import axios from 'axios';
import { cloneDeep } from 'lodash-es';

export class PlainClient {
  private instance: any;
  private readonly options: any;

  constructor(options: any) {
    this.options = options;
    this.instance = axios.create(options);
  }

  private getTransform() {
    return this.options.transform;
  }

  private setupInterceptors() {
    return this.getTransform();
  }

  get(config: any, options?: any) {
    return this.request({ ...config, method: 'GET' }, options);
  }

  post(config: any, options?: any) {
    return this.request({ ...config, method: 'POST' }, options);
  }

  put(config: any, options?: any) {
    return this.request({ ...config, method: 'PUT' }, options);
  }

  delete(config: any, options?: any) {
    return this.request({ ...config, method: 'DELETE' }, options);
  }

  request(config: any, options?: any) {
    let conf = cloneDeep(config);
    const { beforeRequestHook } = this.getTransform() || {};
    if (beforeRequestHook) {
      conf = beforeRequestHook(conf, options);
    }
    return this.instance.request(conf);
  }
}

export const plain = new PlainClient({ transform: {} });

export const plainList = () => plain.get({ url: '/sys/user/list' });
