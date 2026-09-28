import { Component, inject, OnInit } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

import { OrderBadge } from './order-badge';
import { reload } from './order-format';

@Component({ selector: 'shop-order-list', template: '<ul></ul>', imports: [OrderBadge] })
export class OrderList implements OnInit {
  private readonly orders = inject(OrderService);

  ngOnInit(): void {
    this.orders.list().subscribe();
  }

  drop(id: number): void {
    this.orders.remove(id).subscribe();
  }

  again(): void {
    reload(this.orders).subscribe();
  }
}
