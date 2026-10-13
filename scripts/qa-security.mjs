// Test-only helper. Secrets stay in memory and are never printed or persisted.
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
export function totp(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(
    (bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac("sha1", key).update(counter).digest(),
    off = h[19] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export async function enrollStudio(request, email, password) {
  const login = await request("/security/login", { email, password });
  assert.equal(
    login.status,
    200,
    JSON.stringify({ status: login.status, message: login.data?.message }),
  );
  assert.equal(login.data.challenge, "setup");
  const authenticated = await request("/security/respond", {
    ticket: login.data.ticket,
    code: totp(login.data.secret, login.serverTime || Date.now()),
  });
  assert.equal(
    authenticated.status,
    200,
    JSON.stringify({
      status: authenticated.status,
      message: authenticated.data?.message,
    }),
  );
  assert.ok(authenticated.data.adminSession);
  const replay = await request("/security/respond", {
    ticket: login.data.ticket,
    code: totp(login.data.secret, login.serverTime || Date.now()),
  });
  assert.equal(replay.status, 401);
  return authenticated.data;
}
