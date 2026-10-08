"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type FormEvent, useState } from "react";
import { z } from "zod";

import type { AuthConfigView } from "@/app/studio/api";

/** Same actor-id rule the registration endpoint enforces. */
const ACTOR_ID = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

const signUpInput = z
  .object({
    actorId: z
      .string()
      .trim()
      .toLowerCase()
      .regex(ACTOR_ID, "Use 1–64 lowercase letters, digits, dots, dashes, or underscores"),
    email: z.string().trim().toLowerCase().regex(EMAIL, "Enter a valid email address"),
    password: z.string().min(12, "Password must be at least 12 characters").max(256),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export interface SignUpAccount {
  readonly actorId: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Sign-up card adapted from the official shadcn `signup-01` block.
 * Tokens come from Nexora's CSS variables. The Google action in the block
 * has no endpoint here, so it is omitted.
 */
export function SignUpScreen(props: {
  readonly config: AuthConfigView | null;
  readonly loadError: string | null;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly onSubmit: (account: SignUpAccount) => Promise<void>;
}) {
  const [localError, setLocalError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = signUpInput.safeParse({
      actorId: form.get("actorId"),
      email: form.get("email"),
      password: form.get("password"),
      confirmPassword: form.get("confirmPassword"),
    });
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Check the form");
      return;
    }
    setLocalError(null);
    await props.onSubmit({
      actorId: parsed.data.actorId,
      email: parsed.data.email,
      password: parsed.data.password,
    });
  }

  if (props.loadError) {
    return (
      <Card data-testid="signup-screen">
        <CardHeader>
          <p className="nx-kicker">Nexora</p>
          <CardTitle>
            <h1>Create an account</h1>
          </CardTitle>
          <CardDescription>{props.loadError}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" render={<a href="/studio" />}>
            Sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (props.config === null) {
    return (
      <Card data-testid="signup-loading" aria-busy="true" aria-live="polite">
        <CardHeader>
          <div className="nx-skel" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="nx-skel" />
          <div className="nx-skel" />
        </CardContent>
      </Card>
    );
  }

  if (!props.config.signupAllowed) {
    return (
      <Card data-testid="signup-screen">
        <CardHeader>
          <p className="nx-kicker">Nexora</p>
          <CardTitle>
            <h1>Create an account</h1>
          </CardTitle>
          <CardDescription data-testid="signup-disabled">
            Self sign-up is turned off on this deployment. An operator creates accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldDescription className="px-0 text-center">
            <a href="/studio">Sign in</a>
          </FieldDescription>
        </CardContent>
      </Card>
    );
  }

  const message = localError ?? props.notice;

  return (
    <Card data-testid="signup-screen">
      <CardHeader>
        <p className="nx-kicker">Nexora</p>
        <CardTitle>
          <h1>Create an account</h1>
        </CardTitle>
        <CardDescription>
          The kernel keeps the books. This account can open a company after you sign in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)} aria-label="Create account">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="signup-actor">Actor id</FieldLabel>
              <Input
                id="signup-actor"
                name="actorId"
                type="text"
                autoComplete="username"
                spellCheck={false}
                data-testid="signup-actor"
                required
              />
              <FieldDescription>
                Lowercase letters, digits, dots, dashes, or underscores. This is how you sign in.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-email">Email</FieldLabel>
              <Input
                id="signup-email"
                name="email"
                type="email"
                autoComplete="email"
                data-testid="signup-email"
                required
              />
              <FieldDescription>
                Used for a sign-in link. It is stored with the account, not shared from this page.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <Input
                id="signup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                data-testid="signup-password"
                required
              />
              <FieldDescription>At least 12 characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="signup-confirm">Confirm password</FieldLabel>
              <Input
                id="signup-confirm"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                data-testid="signup-confirm"
                required
              />
            </Field>
            {message ? <FieldError>{message}</FieldError> : null}
            <Field>
              <Button
                type="submit"
                className="w-full"
                disabled={props.busy}
                data-testid="signup-submit"
              >
                {props.busy ? "Creating account" : "Create account"}
              </Button>
              <FieldDescription className="text-center">
                Already have an account? <a href="/studio">Sign in</a>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
