"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type FormEvent, useState } from "react";

import { API_URL, type AuthConfigView } from "./api";

const DEMO_ACTORS = ["sindhu", "controller", "viewer", "platform-admin"] as const;

export function SignInScreen(props: {
  readonly config: AuthConfigView;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly challengeId: string | null;
  readonly onPassword: (actorId: string, password: string) => Promise<void>;
  readonly onMagicLink: (email: string) => Promise<void>;
  readonly onSecondFactor: (code: string, recovery: boolean) => Promise<void>;
}) {
  const [magic, setMagic] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const demo = props.config.demoMode;

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await props.onPassword(
      String(form.get("actorId") ?? "").trim(),
      String(form.get("password") ?? ""),
    );
  }

  async function onMagic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await props.onMagicLink(String(form.get("email") ?? "").trim());
  }

  async function onFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await props.onSecondFactor(String(form.get("code") ?? "").trim(), recovery);
  }

  return (
    <main className="nx-gate" data-testid="signin-screen">
      <form
        className="nx-signin"
        onSubmit={props.challengeId ? onFactor : magic ? onMagic : onPassword}
      >
        <p className="nx-kicker">Nexora</p>
        <h1>Board-ready and deal-ready, with a person still in charge.</h1>
        <p>
          The kernel computes the numbers. Agents only propose.
          {demo
            ? " Sign in to the Nazareno Services demo, or use your own account."
            : " Sign in to continue."}
        </p>
        {props.challengeId ? (
          <>
            <p>Enter the code from your authenticator, or a recovery code.</p>
            <label>
              {recovery ? "Recovery code" : "Authenticator code"}
              <Input
                name="code"
                inputMode={recovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                data-testid="signin-otp"
                required
              />
            </label>
            <button
              type="button"
              className="nx-text-btn"
              onClick={() => setRecovery((current) => !current)}
            >
              {recovery ? "Use an authenticator code" : "Use a recovery code"}
            </button>
          </>
        ) : magic ? (
          <label>
            Email
            <Input
              name="email"
              type="email"
              autoComplete="email"
              data-testid="magic-email"
              required
            />
          </label>
        ) : (
          <>
            <label>
              Actor or email
              <Input
                name="actorId"
                defaultValue={demo ? "sindhu" : undefined}
                autoComplete="username"
                data-testid="signin-actor"
                required
              />
            </label>
            <label>
              Password
              <Input
                name="password"
                type="password"
                defaultValue={demo ? "nexora-demo-2026" : undefined}
                autoComplete="current-password"
                data-testid="signin-password"
                required
              />
            </label>
          </>
        )}
        <Button type="submit" disabled={props.busy} data-testid="signin-submit">
          {props.busy
            ? "Signing in"
            : props.challengeId
              ? "Verify and continue"
              : magic
                ? "Email a sign-in link"
                : "Open the company"}
        </Button>
        {!props.challengeId ? (
          <button
            type="button"
            className="nx-text-btn"
            data-testid="signin-magic-toggle"
            onClick={() => setMagic((current) => !current)}
          >
            {magic ? "Use a password instead" : "Email me a sign-in link"}
          </button>
        ) : null}
        {props.config.oidcProviders.map((provider) => (
          <a key={provider.id} href={`${API_URL}/auth/oidc/${provider.id}/start`}>
            Continue with {provider.label}
          </a>
        ))}
        {props.notice ? (
          <p className="nx-notice" role="alert" data-testid="signin-notice">
            {props.notice}
          </p>
        ) : null}
        {demo && !magic && !props.challengeId ? (
          <ul className="nx-demo-actors" data-testid="demo-actors">
            {DEMO_ACTORS.map((actor) => (
              <li key={actor}>{actor}</li>
            ))}
          </ul>
        ) : null}
      </form>
    </main>
  );
}

export function TwoFactorPanel(props: {
  readonly secret: string;
  readonly qrDataUrl: string;
  readonly recoveryCodes: readonly string[];
  readonly busy: boolean;
  readonly notice: string | null;
  readonly onConfirm: (code: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await props.onConfirm(String(form.get("code") ?? "").trim());
  }

  return (
    <section className="nx-factor" data-testid="screen-2fa">
      <h2>Two-factor authentication</h2>
      <p>
        Scan the code with an authenticator app, then enter the 6-digit code. Recovery codes are
        shown once.
      </p>
      {props.qrDataUrl ? (
        <img src={props.qrDataUrl} alt="Authenticator QR code" data-testid="totp-qr" />
      ) : null}
      <p className="nx-secret" data-testid="totp-secret">
        {props.secret}
      </p>
      {props.recoveryCodes.length > 0 ? (
        <ul data-testid="recovery-codes">
          {props.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
      ) : (
        <form onSubmit={onSubmit}>
          <label>
            Authenticator code
            <Input name="code" inputMode="numeric" data-testid="totp-confirm" required />
          </label>
          <Button type="submit" disabled={props.busy}>
            Enable two-factor
          </Button>
        </form>
      )}
      {props.notice ? (
        <p className="nx-notice" role="alert">
          {props.notice}
        </p>
      ) : null}
      <button type="button" className="nx-text-btn" onClick={props.onClose}>
        Close
      </button>
    </section>
  );
}
