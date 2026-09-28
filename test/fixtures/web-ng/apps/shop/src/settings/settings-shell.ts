import { Component, inject, OnInit } from '@angular/core';

import { OrderService } from '@shop/data/order.service';

// The parent: it holds the outlet its children render in.
@Component({ selector: 'shop-settings', template: '<router-outlet></router-outlet>' })
export class SettingsShell implements OnInit {
  private readonly orders = inject(OrderService);

  ngOnInit(): void {
    this.orders.list().subscribe();
  }
}
