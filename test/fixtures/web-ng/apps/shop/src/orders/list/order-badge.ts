import { Component, inject } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

// A component the list mounts in its template: a CHILD of every screen that
// mounts the list, the way an imported `.vue` file is.
@Component({ selector: 'shop-order-badge', template: '<span></span>' })
export class OrderBadge {
  private readonly orders = inject(OrderService);

  refresh(): void {
    this.orders.feed().subscribe();
  }
}
