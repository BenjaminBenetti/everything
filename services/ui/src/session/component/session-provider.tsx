import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  BrowserSession,
  SessionProfile,
  SessionCredentials,
} from "@everything/security/browser";

interface SessionState {
  /** Authenticate and update the mounted application without navigation. */
  signIn(credentials: SessionCredentials): Promise<void>;
  /** Clear the mounted profile after server-side revocation. */
  signOut(): Promise<void>;
  readonly profile: SessionProfile | null;
  readonly loading: boolean;
  readonly error: string | null;
}
const SessionContext = createContext<SessionState | null>(null);

/** Restore authentication while keeping identity-provider details outside page components. */
export function SessionProvider({
  session,
  children,
}: {
  session: BrowserSession;
  children: ReactNode;
}) {
  const [state, setState] = useState<Omit<SessionState, "signIn" | "signOut">>({
    profile: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    let active = true;
    session
      .initialize()
      .then((profile) => {
        if (active) setState({ profile, loading: false, error: null });
      })
      .catch(() => {
        if (active)
          setState({
            profile: null,
            loading: false,
            error: "Sign-in is temporarily unavailable. Please try again.",
          });
      });
    return () => {
      active = false;
    };
  }, [session]);
  /** Keep only display state after exchanging transient credentials. */
  async function signIn(credentials: SessionCredentials): Promise<void> {
    const profile = await session.signIn(credentials);
    setState({ profile, loading: false, error: null });
  }
  /** End the session on the server before rendering the welcome screen. */
  async function signOut(): Promise<void> {
    await session.signOut();
    setState({ profile: null, loading: false, error: null });
  }
  return (
    <SessionContext.Provider value={{ signIn, signOut, ...state }}>
      {children}
    </SessionContext.Provider>
  );
}

/** Require the session boundary supplied by the application root. */
export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is required");
  return value;
}
