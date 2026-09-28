import { Component, inject } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

@Component({ selector: 'shop-audit-log', template: '<table></table>' })
export class AuditLog {
  private readonly orders = inject(OrderService);

  submit(order: object): void {
    this.orders.save(order).subscribe();
  }
}
