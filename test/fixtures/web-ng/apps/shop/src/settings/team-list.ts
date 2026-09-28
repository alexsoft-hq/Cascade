import { Component, inject } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

// The empty-path child of a parent with NO component: it is the screen at
// `/settings/team` on its own.
@Component({ selector: 'shop-team-list', template: '<ul></ul>' })
export default class TeamList {
  private readonly orders = inject(OrderService);

  refresh(): void {
    this.orders.feed().subscribe();
  }
}
