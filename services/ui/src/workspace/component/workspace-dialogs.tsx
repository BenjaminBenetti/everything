import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Agent } from "@everything/agent-contracts";
import { AgentEditor } from "../../agent/component/agent-editor.js";
import { AgentDetails } from "../../agent/component/agent-details.js";
import { AgentDeletionDialog } from "../../agent/component/agent-deletion-dialog.js";
import { NotificationDialog } from "../../notification/component/notification-dialog.js";
import { PreferencesDialog } from "../../preferences/component/preferences-dialog.js";
import { ProviderDialog } from "../../provider/component/provider-dialog.js";
import { SettingsDialog } from "../../settings/component/settings-dialog.js";

type WorkspaceDialog =
  | { kind: "editor"; agent?: Agent }
  | { kind: "details"; agent: Agent; focusDelete?: boolean }
  | { kind: "deletion"; agent: Agent }
  | { kind: "notifications" }
  | { kind: "provider" }
  | { kind: "preferences" }
  | { kind: "settings" };
interface WorkspaceDialogs {
  /** Open a workspace action and remember its keyboard focus target. */
  open(dialog: WorkspaceDialog): void;
}
const DialogContext = createContext<WorkspaceDialogs | null>(null);

/** Coordinate one modal at a time and announce successful persistence operations. */
export function WorkspaceDialogsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(() =>
    new URLSearchParams(location.hash.slice(1)).has("chatgpt")
      ? { kind: "provider" }
      : null,
  );
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  /** Capture the actual opener before portaling a modal. */
  function open(next: WorkspaceDialog): void {
    document
      .querySelector("[data-dialog-return]")
      ?.removeAttribute("data-dialog-return");
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.setAttribute("data-dialog-return", "");
    setDialog(next);
  }
  /** Dismiss the current modal. */
  function close(): void {
    setDialog(null);
  }
  return (
    <DialogContext.Provider value={{ open }}>
      {children}
      {dialog?.kind === "editor" && (
        <AgentEditor
          {...(dialog.agent ? { agent: dialog.agent } : {})}
          onClose={close}
          onSaved={setNotice}
        />
      )}
      {dialog?.kind === "details" && (
        <AgentDetails
          agent={dialog.agent}
          onClose={close}
          onEdit={() => setDialog({ kind: "editor", agent: dialog.agent })}
          onDelete={() => setDialog({ kind: "deletion", agent: dialog.agent })}
          focusDelete={dialog.focusDelete ?? false}
        />
      )}
      {dialog?.kind === "deletion" && (
        <AgentDeletionDialog
          agent={dialog.agent}
          onCancel={() =>
            setDialog({
              kind: "details",
              agent: dialog.agent,
              focusDelete: true,
            })
          }
          onDeleted={() => {
            setNotice("Teammate deleted.");
            close();
          }}
        />
      )}
      {dialog?.kind === "notifications" && (
        <NotificationDialog onClose={close} />
      )}
      {dialog?.kind === "provider" && <ProviderDialog onClose={close} />}
      {dialog?.kind === "preferences" && <PreferencesDialog onClose={close} />}
      {dialog?.kind === "settings" && <SettingsDialog onClose={close} />}
      <div
        className={`toast ${notice ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {notice}
      </div>
    </DialogContext.Provider>
  );
}

/** Resolve the action boundary used by independent workspace pages. */
export function useWorkspaceDialogs(): WorkspaceDialogs {
  const value = useContext(DialogContext);
  if (!value) throw new Error("WorkspaceDialogsProvider is required");
  return value;
}
