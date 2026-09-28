import { Routes } from '@angular/router';

export const extraRoutes: Routes = [
  { path: 'profile', loadComponent: () => import('./profile.page').then((m) => m.ProfilePage) },
];
