import { Routes } from '@angular/router';

// The first route of a lazily loaded list is '': it renders in the loading
// route's outlet at the loading route's own path.
const auditRoutes: Routes = [
  { path: '', loadComponent: () => import('./audit-log').then((m) => m.AuditLog) },
];

export default auditRoutes;
