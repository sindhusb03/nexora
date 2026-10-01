import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentity } from "./identity";
import {
  clearDataSource,
  EMPTY_SOURCE,
  readDataSource,
  setDataSourceIdentity,
  writeDataSource,
} from "./data-source";

describe("uploaded source isolation", () => {
  afterEach(() => {
    cleanup();
    clearDataSource();
    vi.unstubAllGlobals();
  });
  const owner = { actorId: "owner", tenantId: "tenant-a" };
  const source = {
    ...EMPTY_SOURCE,
    rows: [{ rowNo: 1, account: "Cash", amount: "10", category: "Cash", suggestedCategory: null }],
  };
  it("useIdentity.signOut clears uploaded rows before awaiting logout and preserves its CSRF header", async () => {
    const signed = {
      ...owner,
      region: "us-east-1",
      roles: [],
      platformAdmin: false,
      expiresAt: null,
      csrfToken: "csrf-test",
    };
    let finishLogout!: (response: Response) => void;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishLogout = resolve;
        });
      return Promise.resolve(new Response(JSON.stringify(signed), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useIdentity());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    writeDataSource(source);
    let logout!: Promise<void>;
    act(() => {
      logout = result.current.signOut();
    });
    expect(readDataSource().rows).toEqual([]);
    expect(sessionStorage.getItem("nexora.dataSource")).toBeNull();
    expect(result.current.state.status).toBe("signed-out");
    const headers = new Headers(fetch.mock.calls.at(-1)?.[1]?.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-test");
    await act(async () => {
      finishLogout(new Response("{}", { status: 200 }));
      await logout;
    });
  });
  it("clears storage and memory on sign-out", () => {
    setDataSourceIdentity(owner);
    writeDataSource(source);
    expect(readDataSource().rows).toHaveLength(1);
    clearDataSource();
    expect(sessionStorage.getItem("nexora.dataSource")).toBeNull();
    expect(readDataSource().rows).toEqual([]);
  });
  it.each([
    { actorId: "other", tenantId: "tenant-a" },
    { actorId: "owner", tenantId: "tenant-b" },
  ])("discards rows on identity change to %j", (next) => {
    setDataSourceIdentity(owner);
    writeDataSource(source);
    setDataSourceIdentity(next);
    expect(sessionStorage.getItem("nexora.dataSource")).toBeNull();
    expect(readDataSource().rows).toEqual([]);
    setDataSourceIdentity(owner);
    expect(readDataSource().rows).toEqual([]);
  });
  it("rejects a delayed upload from an old identity", () => {
    setDataSourceIdentity(owner);
    setDataSourceIdentity({ ...owner, actorId: "other" });
    writeDataSource(source, owner);
    expect(readDataSource().rows).toEqual([]);
  });
  it("rejects a delayed upload even after the same actor signs back in", () => {
    setDataSourceIdentity(owner);
    const pending = { ...readDataSource(), rows: source.rows };
    clearDataSource();
    setDataSourceIdentity(owner);
    writeDataSource(pending, owner);
    expect(readDataSource().rows).toEqual([]);
  });
});
