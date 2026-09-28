import { HttpClient } from '@angular/common/http';
import { Inject, Injectable, InjectionToken } from '@angular/core';

export const ITEM_CONFIG = new InjectionToken<object>('item-config');

@Injectable({ providedIn: 'root' })
export class ItemService {
  // A parameter property is TypeScript's own field declaration; the decorated
  // one is handed whatever the token names, which is not the type beside it.
  constructor(
    private readonly http: HttpClient,
    @Inject(ITEM_CONFIG) private readonly config: HttpClient,
  ) {}

  all() {
    return this.http.get('/api/items');
  }

  viaConfig() {
    return this.config.get('/api/items/config');
  }
}
