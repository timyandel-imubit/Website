// Encrypts Plaid access tokens at rest (AES-256-GCM). The key comes from
// STEWARD_SECRET, or is generated once into data/.key with owner-only perms.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

function loadKey() {
  if (process.env.STEWARD_SECRET) {
    return crypto.createHash("sha256").update(process.env.STEWARD_SECRET).digest();
  }
  const keyPath = path.join(DATA_DIR, ".key");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
}

const KEY = loadKey();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
