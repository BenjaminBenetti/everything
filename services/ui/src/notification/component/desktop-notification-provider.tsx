import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import type { DesktopNotifications } from "../interface/desktop-notifications.js";
import { DeliveryNotifier } from "../service/delivery-notifier.js";
import { NotificationAttention } from "../service/notification-attention.js";
import { NotificationClaims } from "../service/notification-claims.js";
import { NotificationPreferences } from "../service/notification-preferences.js";

/** Everything desktop notifications need in this tab, shared by settings, the feed, and open chats. */
interface DesktopNotificationServices {
  readonly notifications: DesktopNotifications;
  readonly preferences: NotificationPreferences;
  readonly attention: NotificationAttention;
  readonly notifier: DeliveryNotifier;
}

const DesktopNotificationContext =
  createContext<DesktopNotificationServices | null>(null);

/** Supply desktop notifications through the browser capability assembled at the application boundary. */
export function DesktopNotificationProvider({
  notifications,
  children,
}: {
  notifications: DesktopNotifications;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const navigation = useRef(navigate);
  navigation.current = navigate;
  const [services] = useState(() => {
    const attention = new NotificationAttention();
    return {
      notifications,
      preferences: new NotificationPreferences(),
      attention,
      notifier: new DeliveryNotifier({
        notifications,
        claims: new NotificationClaims(),
        attending: (agentId) => attention.attending(agentId),
        open: (path) => {
          window.focus();
          void navigation.current(path);
        },
      }),
    };
  });
  return (
    <DesktopNotificationContext.Provider value={services}>
      {children}
    </DesktopNotificationContext.Provider>
  );
}

/** Resolve this tab's desktop notification services. */
export function useDesktopNotificationServices(): DesktopNotificationServices {
  const services = useContext(DesktopNotificationContext);
  if (!services) throw new Error("DesktopNotificationProvider is required");
  return services;
}
