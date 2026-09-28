import { Component, inject } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

// The empty-path child: what the shell's outlet shows at `/settings` itself.
@Component({ selector: 'shop-settings-general', template: '<form></form>' })
export class SettingsGeneral {
  private readonly orders = inject(OrderService);

  close(id: number): void {
    this.orders.remove(id).subscribe();
  }
}
