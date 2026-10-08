import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignUpScreen } from "@/components/signup-form";
import SignUpPage from "../app/studio/sign-up/page";
import { ApiFailure, fetchAuthConfig, login, signup } from "../app/studio/api";
import { SignInScreen } from "../app/studio/sign-in";
import type { AuthConfigView } from "../app/studio/api";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("../app/studio/api", () => {
  class ApiFailure extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiFailure,
    fetchAuthConfig: vi.fn(),
    signup: vi.fn(),
    login: vi.fn(),
  };
});

const allowed: AuthConfigView = {
  demoMode: true,
  signupAllowed: true,
  region: "us-east-1",
  oidcProviders: [],
};

const closed: AuthConfigView = { ...allowed, signupAllowed: false };

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.mocked(fetchAuthConfig).mockReset();
  vi.mocked(signup).mockReset();
  vi.mocked(login).mockReset();
});

describe("sign-up page", () => {
  it("shows a plain message when sign-up is turned off", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue(closed);
    render(<SignUpPage />);
    expect(await screen.findByTestId("signup-disabled")).toHaveTextContent(
      "An operator creates accounts",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/studio");
    expect(signup).not.toHaveBeenCalled();
  });

  it("registers through the existing endpoint and opens the studio", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue(allowed);
    vi.mocked(signup).mockResolvedValue(undefined);
    vi.mocked(login).mockResolvedValue({
      kind: "session",
      session: {
        actorId: "ada.ok",
        tenantId: null,
        region: "us-east-1",
        roles: [],
        platformAdmin: false,
        csrfToken: "csrf",
      },
    });
    render(<SignUpPage />);
    expect(await screen.findByTestId("signup-actor")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("signup-actor"), { target: { value: "Ada.Ok" } });
    fireEvent.change(screen.getByTestId("signup-email"), {
      target: { value: "Ada.Ok@Example.com" },
    });
    fireEvent.change(screen.getByTestId("signup-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByTestId("signup-confirm"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("signup-submit"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/studio"));
    expect(signup).toHaveBeenCalledWith({
      actorId: "ada.ok",
      email: "ada.ok@example.com",
      password: "correct horse battery staple",
    });
    expect(login).toHaveBeenCalledWith("ada.ok", "correct horse battery staple", "us-east-1");
  });

  it("keeps a mismatched password on the page", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue(allowed);
    render(<SignUpPage />);
    await screen.findByTestId("signup-actor");
    fireEvent.change(screen.getByTestId("signup-actor"), { target: { value: "ada.ok" } });
    fireEvent.change(screen.getByTestId("signup-email"), {
      target: { value: "ada.ok@example.com" },
    });
    fireEvent.change(screen.getByTestId("signup-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByTestId("signup-confirm"), {
      target: { value: "different password" },
    });
    fireEvent.click(screen.getByTestId("signup-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match");
    expect(signup).not.toHaveBeenCalled();
  });

  it("turns the disabled response into the same plain message", async () => {
    vi.mocked(fetchAuthConfig).mockResolvedValue(allowed);
    vi.mocked(signup).mockRejectedValue(
      new ApiFailure(
        403,
        "Self sign-up is disabled on this deployment; an operator creates accounts",
      ),
    );
    render(<SignUpPage />);
    await screen.findByTestId("signup-actor");
    fireEvent.change(screen.getByTestId("signup-actor"), { target: { value: "ada.ok" } });
    fireEvent.change(screen.getByTestId("signup-email"), {
      target: { value: "ada.ok@example.com" },
    });
    fireEvent.change(screen.getByTestId("signup-password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByTestId("signup-confirm"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByTestId("signup-submit"));
    expect(await screen.findByTestId("signup-disabled")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("sign-up screen", () => {
  it("links back to sign-in", () => {
    render(
      <SignUpScreen
        config={allowed}
        loadError={null}
        busy={false}
        notice={null}
        onSubmit={async () => undefined}
      />,
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/studio");
  });
});

describe("sign-in link", () => {
  it("links to sign-up only when the deployment allows it", () => {
    const props = {
      busy: false,
      notice: null,
      challengeId: null,
      onPassword: async () => undefined,
      onMagicLink: async () => undefined,
      onSecondFactor: async () => undefined,
    };
    const { rerender } = render(<SignInScreen {...props} config={allowed} />);
    expect(screen.getByTestId("signin-signup")).toHaveAttribute("href", "/studio/sign-up");
    rerender(<SignInScreen {...props} config={closed} />);
    expect(screen.queryByTestId("signin-signup")).not.toBeInTheDocument();
  });
});
