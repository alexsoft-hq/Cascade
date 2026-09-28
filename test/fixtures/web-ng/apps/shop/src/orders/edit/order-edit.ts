import { Component, inject } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

@Component({ selector: 'shop-order-edit', template: '<form></form>' })
export default class OrderEdit {
  private readonly orders = inject(OrderService);

  submit(order: object): void {
    this.orders.save(order).subscribe();
  }
}
