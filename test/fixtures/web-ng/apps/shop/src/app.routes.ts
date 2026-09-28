import { Routes } from '@angular/router';

import { appPaths } from '@shop/paths/paths';

import { HomePage } from './home/home.page';

export const routes: Routes = [
  { path: '', component: HomePage, title: 'Home' },
  {
    path: appPaths.orders.path,
    loadChildren: () => import('./orders/orders.routes'),
  },
  {
    path: appPaths.items.path,
    loadChildren: () => import('./items/items.routes').then((m) => m.ITEM_ROUTES),
  },
  { path: 'account', loadChildren: () => import('./account/account.routes') },
  { path: 'side', loadComponent: () => import('./side/side.panel'), outlet: 'aside' },
  {
    path: 'legacy',
    loadChildren: () => import('./legacy/legacy.module').then((m) => m.LegacyModule),
  },
  { path: appPaths.reports.path, component: HomePage },
  { path: 'settings', loadChildren: () => import('./settings/settings.routes') },
  { path: '**', redirectTo: '' },
];
