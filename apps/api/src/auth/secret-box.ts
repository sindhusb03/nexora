import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Encrypts a TOTP secret with a key derived from AUTH_SECRET. The plaintext never hits the database. */
export function sealSecret(authSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(authSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openSecret(authSecret: string, sealed: string): string | null {
  const [version, ivText, tagText, bodyText] = sealed.split(".");
  if (version !== "v1" || !ivText || !tagText || !bodyText) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFrom(authSecret),
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(bodyText, "base64url")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

function keyFrom(authSecret: string): Buffer {
  return createHash("sha256").update(authSecret).digest();
}
