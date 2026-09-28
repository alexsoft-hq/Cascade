import { Routes } from '@angular/router';

import { appPaths } from '@shop/paths/paths';

const orderRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./list/order-list').then((m) => m.OrderList),
  },
  {
    path: appPaths.orders.edit.path,
    loadComponent: () => import('./edit/order-edit'),
  },
];

export default orderRoutes;
