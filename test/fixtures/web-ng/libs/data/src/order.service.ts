import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);

  list() {
    return this.http.get<string[]>('/api/orders', { params: new HttpParams() });
  }

  save(order: object) {
    return this.http.request('POST', '/api/orders', { body: order });
  }

  resend(method: string, order: object) {
    return this.http.request(method, '/api/orders/resend', { body: order });
  }

  remove(id: number) {
    return this.http.delete(`/api/orders/${id}`);
  }

  feed() {
    return this.http.jsonp('/api/feed', 'callback');
  }
}
