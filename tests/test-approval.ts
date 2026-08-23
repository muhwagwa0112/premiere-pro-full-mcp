import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalAuthenticator } from "../src/security/confirmation.js";

const key = randomBytes(32);

export const testApprovalAuthenticator: ApprovalAuthenticator = {
  async sign(message) { return createHmac("sha256", key).update(message).digest("base64url"); },
  async verify(message, signature) {
    const expected = Buffer.from(createHmac("sha256", key).update(message).digest("base64url"));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  },
};

export async function approveForTest(approvalId: string, directory: string): Promise<void> {
  const pending = join(directory, `pending-${approvalId}.json`);
  const envelope = JSON.parse(await readFile(pending, "utf8")) as { payload: string; signature: string };
  if (!await testApprovalAuthenticator.verify(envelope.payload, envelope.signature)) throw new Error("Test pending signature is invalid");
  const payload = JSON.parse(envelope.payload) as Record<string, unknown>;
  payload.state = "approved";
  payload.approvedAt = Date.now();
  const approvedPayload = JSON.stringify(payload);
  await writeFile(join(directory, `approved-${approvalId}.json`), JSON.stringify({ payload: approvedPayload, signature: await testApprovalAuthenticator.sign(approvedPayload) }));
  await rm(pending, { force: true });
}
