import { OrderService } from '@shop/data/order.service';

// A plain module the list imports. It is not a component, so a screen does not
// render it; it only reaches HTTP through the service it is handed.
export function reload(service: OrderService) {
  return service.list();
}
