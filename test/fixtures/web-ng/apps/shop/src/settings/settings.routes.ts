import { Routes } from '@angular/router';

import { AuditShell } from './audit/audit-shell';
import { SettingsGeneral } from './settings-general';
import { SettingsShell } from './settings-shell';

// Every form an EMPTY path takes under a parent. At `/settings` the router
// renders the shell AND, in the shell's outlet, the child whose path is ''.
const settingsRoutes: Routes = [
  {
    path: '',
    component: SettingsShell,
    children: [
      { path: '', component: SettingsGeneral },
      { path: 'mail', loadComponent: () => import('./settings-mail').then((m) => m.SettingsMail) },
      { path: 'general', redirectTo: '' },
      { path: 'team', children: [{ path: '', loadComponent: () => import('./team-list') }] },
      {
        path: 'audit',
        component: AuditShell,
        loadChildren: () => import('./audit/audit.routes'),
      },
    ],
  },
];

export default settingsRoutes;
