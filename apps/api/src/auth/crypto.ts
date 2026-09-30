import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

import { argon2idAsync } from "@noble/hashes/argon2.js";

const KEY_LENGTH = 64;

/** OWASP password guidance: argon2id, 19 MiB, time cost 2, parallelism 1. */
export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_LENGTH = 32;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { ...options, maxmem: 256 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export interface Argon2Params {
  readonly memoryKiB: number;
  readonly timeCost: number;
}

/** Lower memory keeps tests and the public demo seed fast. Production omits the override. */
export function argon2Params(memoryKiB?: number): Argon2Params {
  if (memoryKiB === undefined) {
    return { memoryKiB: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST };
  }
  return {
    memoryKiB,
    timeCost: memoryKiB >= ARGON2_MEMORY_KIB ? ARGON2_TIME_COST : 1,
  };
}

/** PHC string: $argon2id$v=19$m=...,t=...,p=1$salt$hash */
export async function hashPassword(password: string, memoryKiB?: number): Promise<string> {
  const params = argon2Params(memoryKiB);
  const salt = randomBytes(16);
  const key = await argon2idAsync(password.normalize("NFKC"), salt, {
    t: params.timeCost,
    m: params.memoryKiB,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_LENGTH,
  });
  return [
    "$argon2id",
    "v=19",
    `m=${params.memoryKiB},t=${params.timeCost},p=${ARGON2_PARALLELISM}`,
    salt.toString("base64url"),
    Buffer.from(key).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2id$")) return verifyArgon2(password, stored);
  return verifyScrypt(password, stored);
}

async function verifyArgon2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return false;
  const cost = parts[3];
  const saltText = parts[4];
  const hashText = parts[5];
  if (!cost || !saltText || !hashText) return false;
  const memory = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(cost);
  if (!memory) return false;
  const memoryKiB = Number(memory[1]);
  const timeCost = Number(memory[2]);
  const parallelism = Number(memory[3]);
  if (![memoryKiB, timeCost, parallelism].every((value) => Number.isInteger(value) && value > 0)) {
    return false;
  }
  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== ARGON2_LENGTH) return false;
  const actual = Buffer.from(
    await argon2idAsync(password.normalize("NFKC"), Buffer.from(saltText, "base64url"), {
      t: timeCost,
      m: memoryKiB,
      p: parallelism,
      dkLen: ARGON2_LENGTH,
    }),
  );
  return timingSafeEqual(actual, expected);
}

async function verifyScrypt(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, hashText] = parts;
  const cost = Number(n);
  const blockSize = Number(r);
  const parallelism = Number(p);
  if (
    ![cost, blockSize, parallelism].every((value) => Number.isInteger(value) && value > 0) ||
    !saltText ||
    !hashText
  ) {
    return false;
  }
  const expected = Buffer.from(hashText, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, Buffer.from(saltText, "base64url"), {
    N: cost,
    r: blockSize,
    p: parallelism,
  });
  return timingSafeEqual(actual, expected);
}

const dummyHashes = new Map<string, Promise<string>>();

/** Spends the same work as a real check so a missing actor is not distinguishable by timing. */
export async function burnPasswordCheck(password: string, memoryKiB?: number): Promise<false> {
  const key = memoryKiB === undefined ? "default" : String(memoryKiB);
  let dummy = dummyHashes.get(key);
  if (!dummy) {
    dummy = hashPassword(randomBytes(16).toString("hex"), memoryKiB);
    dummyHashes.set(key, dummy);
  }
  await verifyPassword(password, await dummy);
  return false;
}

function mac(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}|${value}`).digest("base64url");
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSessionId(secret: string, sessionId: string): string {
  return `${sessionId}.${mac(secret, "session", sessionId)}`;
}

/** Returns the session id only when the signature matches. */
export function readSignedSessionId(secret: string, cookie: string): string | null {
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  return equalText(signature, mac(secret, "session", sessionId)) ? sessionId : null;
}

export function csrfTokenFor(secret: string, sessionId: string): string {
  return mac(secret, "csrf", sessionId);
}

export function csrfTokenMatches(secret: string, sessionId: string, token: string): boolean {
  return equalText(token, csrfTokenFor(secret, sessionId));
}
