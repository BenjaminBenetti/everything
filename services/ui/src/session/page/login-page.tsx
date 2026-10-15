import { useState, type FormEvent } from "react";
import { sessionInputLimits } from "@everything/security/browser";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Brand, GridArt } from "@everything/ui/brand";
import { Button } from "@everything/ui/button";
import { useSession } from "../component/session-provider.js";

/** Show the welcome message and collect credentials through the session boundary. */
export function LoginPage() {
  const { signIn, error: initializationError } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  /** Submit transient credentials and leave failures inline on the form. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending(true);
    setError("");
    try {
      await signIn({
        username: String(fields.get("username") ?? ""),
        password: String(fields.get("password") ?? ""),
      });
      form.reset();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Sign-in is temporarily unavailable. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className={`login ${pending ? "signing-in" : ""}`}>
      <section className="welcome">
        <Brand />
        <div className="welcome-copy">
          <h1>
            Your work.
            <br />
            Your life.
            <br />
            <em>Your everything.</em>
          </h1>
          <p>Create teammates to help you do just about anything.</p>
        </div>
        <div className="welcome-bottom">
          <span className="dot" />
          Your workspace in Everything.
        </div>
        <GridArt />
      </section>
      <section className="login-right">
        <Brand className="mobile-brand" />
        <GridArt className="mobile-theme-art" />
        <form
          className="login-form"
          onSubmit={(event) => void submit(event)}
          aria-busy={pending}
        >
          <div className="eyebrow">Your workspace</div>
          <h2>Welcome back.</h2>
          <p className="login-subtitle">Sign in to manage your teammates.</p>
          <label className="field" htmlFor="username">
            Username
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Your username"
              required
              maxLength={sessionInputLimits.username}
              readOnly={pending}
              aria-describedby={error ? "sign-in-error" : undefined}
            />
          </label>
          <label className="field" htmlFor="password">
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              required
              maxLength={sessionInputLimits.password}
              readOnly={pending}
              aria-describedby={error ? "sign-in-error" : undefined}
            />
          </label>
          <Button type="submit" className="login-submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
            <ArrowRight aria-hidden="true" />
          </Button>
          {(initializationError || error) && (
            <p id="sign-in-error" className="form-error" role="alert">
              {error || initializationError}
            </p>
          )}
        </form>
        <div className="login-foot">
          <LockKeyhole aria-hidden="true" />A private workspace for you and your
          teammates.
        </div>
      </section>
    </main>
  );
}
