import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 64;
const DEFAULT_COST = 32_768;

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

/** Format: scrypt$N$r$p$salt$hash, base64url encoded. */
export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N: cost, r: 8, p: 1 });
  return ["scrypt", cost, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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

const dummyHashes = new Map<number, Promise<string>>();

/** Spends the same work as a real check so a missing actor is not distinguishable by timing. */
export async function burnPasswordCheck(password: string, cost = DEFAULT_COST): Promise<false> {
  let dummy = dummyHashes.get(cost);
  if (!dummy) {
    dummy = hashPassword(randomBytes(16).toString("hex"), cost);
    dummyHashes.set(cost, dummy);
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
