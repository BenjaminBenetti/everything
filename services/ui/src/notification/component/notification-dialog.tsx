import { Check, Monitor, Smartphone } from "lucide-react";
import { Button } from "@everything/ui/button";
import { Dialog } from "@everything/ui/dialog";
import { Switch } from "@everything/ui/switch";
import { useDesktopNotificationSettings } from "../hook/use-desktop-notification-settings.js";
import { notificationStatus } from "../model/notification-status.js";

/** Desktop notifications on this device, and phone installation without requesting unusable push permissions. */
export function NotificationDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Notifications"
      description="Choose how Everything lets you know about new messages from your teammates."
      className="notification-dialog"
      onClose={onClose}
      footer={
        <div className="settings-footer">
          <span>
            <Check aria-hidden="true" />
            Saved on this device
          </span>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      <section
        className="settings-section"
        aria-labelledby="desktop-notifications-heading"
      >
        <div className="settings-section-heading">
          <span className="settings-section-icon">
            <Monitor aria-hidden="true" />
          </span>
          <div>
            <h3 id="desktop-notifications-heading">Desktop</h3>
            <p>Get notified on this computer, even in another tab or app.</p>
          </div>
        </div>
        <DesktopNotificationControls />
      </section>
      <section
        className="settings-section"
        aria-labelledby="phone-setup-heading"
      >
        <div className="settings-section-heading">
          <span className="settings-section-icon">
            <Smartphone aria-hidden="true" />
          </span>
          <div>
            <h3 id="phone-setup-heading">Phone setup</h3>
            <p>Add Everything to your Home Screen for quick access.</p>
          </div>
        </div>
        <ol className="steps">
          <li>
            <span className="step-number">1</span>
            <span>
              On iPhone, open Everything in Safari. Tap Share, then{" "}
              <strong>Add to Home Screen</strong>.
            </span>
          </li>
          <li>
            <span className="step-number">2</span>
            <span>
              Choose <strong>Open as Web App</strong>, then Add. Open Everything
              from your Home Screen.
            </span>
          </li>
          <li>
            <span className="step-number">3</span>
            <span>Sign in to access your team.</span>
          </li>
        </ol>
        <p className="availability-note">
          Phone notifications aren’t available yet.
        </p>
      </section>
    </Dialog>
  );
}

/** The desktop switch, with an explanation that matches the browser's permission and the user's choice. */
function DesktopNotificationControls() {
  const { permission, enabled, request, deliveryFailed, change } =
    useDesktopNotificationSettings();
  const status = notificationStatus(
    permission,
    enabled,
    request,
    deliveryFailed,
  );
  return (
    <>
      <Switch
        className="settings-switch"
        label="Desktop notifications"
        description="Show a notification when a teammate sends you a message."
        checked={enabled}
        disabled={
          permission === "unsupported" ||
          permission === "denied" ||
          request === "pending"
        }
        onChange={change}
      />
      <p
        className="settings-status notification-status"
        role={status.problem ? "alert" : "status"}
      >
        {status.message}
      </p>
    </>
  );
}
