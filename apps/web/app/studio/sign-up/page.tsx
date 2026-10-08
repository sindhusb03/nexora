"use client";

import { SignUpScreen, type SignUpAccount } from "@/components/signup-form";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiFailure, fetchAuthConfig, login, signup, type AuthConfigView } from "../api";
import "../studio.css";

export default function SignUpPage() {
  const router = useRouter();
  const [config, setConfig] = useState<AuthConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch(() => {
        if (!cancelled)
          setLoadError("Sign-up settings could not be loaded. Sign in, or try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(account: SignUpAccount) {
    setBusy(true);
    setNotice(null);
    try {
      await signup(account);
      await login(account.actorId, account.password, config?.region ?? null);
      router.push("/studio");
    } catch (caught) {
      if (caught instanceof ApiFailure && caught.message.includes("Self sign-up is disabled")) {
        setClosed(true);
        return;
      }
      setNotice(caught instanceof Error ? caught.message : "The account could not be created");
    } finally {
      setBusy(false);
    }
  }

  const shown = closed && config ? { ...config, signupAllowed: false } : config;

  return (
    <main className="nx-gate" data-testid="signup-page">
      <div className="w-full max-w-sm">
        <SignUpScreen
          config={shown}
          loadError={loadError}
          busy={busy}
          notice={notice}
          onSubmit={onSubmit}
        />
      </div>
    </main>
  );
}
