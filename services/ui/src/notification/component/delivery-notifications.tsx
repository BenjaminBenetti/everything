import { useDeliveryNotifications } from "../hook/use-delivery-notifications.js";

/** Run desktop notifications while a user is signed in; renders nothing. */
export function DeliveryNotifications() {
  useDeliveryNotifications();
  return null;
}
