import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpPaystackClient, isValidPaystackSignature, PaystackError } from "../src/payments/paystack.js";

/** A stand-in for api.paystack.co that records requests and answers per Paystack's API spec. */
let server: Server;
let base: string;
const seen: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
let reply: (req: IncomingMessage) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const { status, body } = reply(req);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new HttpPaystackClient("sk_test_abc", base);

describe("HttpPaystackClient", () => {
  it("starts a transaction with the fields Paystack expects", async () => {
    reply = () => ({ status: 200, body: { status: true, message: "ok", data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x", reference: "dp-1" } } });
    const result = await client().initializeTransaction({
      email: "ada@example.com",
      amountKobo: 2_525_300,
      reference: "dp-1",
      channels: ["bank_transfer"],
      callbackUrl: "https://dettypot.app/pots/1/payments/2",
      metadata: { payment_id: "2" },
    });
    expect(result).toEqual({ authorizationUrl: "https://checkout.paystack.com/x", accessCode: "x", reference: "dp-1" });
    expect(seen.at(-1)).toEqual({
      method: "POST",
      url: "/transaction/initialize",
      auth: "Bearer sk_test_abc",
      body: {
        email: "ada@example.com",
        amount: 2_525_300,
        currency: "NGN",
        reference: "dp-1",
        channels: ["bank_transfer"],
        callback_url: "https://dettypot.app/pots/1/payments/2",
        metadata: { payment_id: "2" },
      },
    });
  });

  it("verifies a transaction and reads amounts and fees as kobo numbers", async () => {
    reply = () => ({
      status: 200,
      body: {
        status: true,
        data: { id: 42, status: "success", reference: "dp-1", amount: 2_525_300, currency: "NGN", fees: 25_253, channel: "bank_transfer", paid_at: "2026-11-08T10:00:00.000Z" },
      },
    });
    const v = await client().verifyTransaction("dp-1");
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/transaction/verify/dp-1" });
    expect(v).toEqual({
      id: 42,
      status: "success",
      reference: "dp-1",
      amountKobo: 2_525_300,
      currency: "NGN",
      feesKobo: 25_253,
      channel: "bank_transfer",
      paidAt: new Date("2026-11-08T10:00:00.000Z"),
    });
  });

  it("keeps a missing fee as unknown rather than zero", async () => {
    reply = () => ({ status: 200, body: { status: true, data: { id: 1, status: "success", reference: "r", amount: 100, currency: "NGN", fees: null, channel: "card", paid_at: null } } });
    expect((await client().verifyTransaction("r")).feesKobo).toBeNull();
  });

  it("reports Paystack's own error message and status", async () => {
    reply = () => ({ status: 404, body: { status: false, message: "Transaction reference not found" } });
    await expect(client().verifyTransaction("nope")).rejects.toMatchObject({ name: "PaystackError", message: "Transaction reference not found", httpStatus: 404 });
  });

  it("treats a 200 that says status:false as a failure", async () => {
    reply = () => ({ status: 200, body: { status: false, message: "Invalid key" } });
    await expect(client().verifyTransaction("r")).rejects.toBeInstanceOf(PaystackError);
  });

  it("reports an unreachable Paystack without a status code", async () => {
    const down = new HttpPaystackClient("sk_test_abc", "http://127.0.0.1:1");
    await expect(down.verifyTransaction("r")).rejects.toMatchObject({ httpStatus: null });
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "dp-1" } }));
  const sign = (b: Buffer, key = "sk_test_abc") => createHmac("sha512", key).update(b).digest("hex");

  it("accept Paystack's HMAC-SHA512 of the raw body", () => {
    expect(isValidPaystackSignature(body, sign(body), "sk_test_abc")).toBe(true);
  });

  it.each([
    ["a different key", sign(body, "sk_test_other")],
    ["a changed body", sign(Buffer.concat([body, Buffer.from(" ")]))],
    ["uppercase hex", sign(body).toUpperCase()],
    ["a short value", sign(body).slice(0, 64)],
    ["no header", undefined],
    ["an array of headers", [sign(body)]],
  ])("reject %s", (_label, signature) => {
    expect(isValidPaystackSignature(body, signature, "sk_test_abc")).toBe(false);
  });
});
