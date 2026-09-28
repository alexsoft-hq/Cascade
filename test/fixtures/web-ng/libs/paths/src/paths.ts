// The application's paths, written once and named everywhere else.
export const appPaths = {
  orders: { path: 'orders', edit: { path: ':id/edit' } },
  items: { path: 'items', create: { path: 'new' } },
} satisfies Record<string, { path: string }>;
