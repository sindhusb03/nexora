import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAuthUrl(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function totpCode(secret: string, now = Date.now()): string {
  const key = base32Decode(secret);
  if (!key) throw new Error("Invalid TOTP secret");
  return hotp(key, Math.floor(now / 1000 / STEP_SECONDS));
}

/** Accepts the current 30-second step and one step on either side. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = base32Decode(secret);
  if (!key) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (const step of [counter - 1, counter, counter + 1]) {
    if (step < 0) continue;
    if (safeEqual(normalized, hotp(key, step))) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 8): readonly string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/[-\s]/g, "").toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function hotp(key: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string): Buffer | null {
  const cleaned = text.replace(/=+$/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(cleaned)) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
