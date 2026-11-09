import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentMethod } from "./fees.js";

/**
 * The parts of the Paystack API DettyPot uses. Field names follow Paystack's
 * official OpenAPI specification (github.com/PaystackOSS/openapi). Amounts are
 * in kobo throughout.
 */
export interface InitializeInput {
  email: string;
  amountKobo: number;
  reference: string;
  channels: PaymentMethod[];
  callbackUrl: string;
  metadata: Record<string, unknown>;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifiedTransaction {
  id: number;
  /** e.g. success, failed, abandoned, ongoing, pending */
  status: string;
  reference: string;
  amountKobo: number;
  currency: string;
  /** What Paystack kept. Null if Paystack didn't report it. */
  feesKobo: number | null;
  channel: string | null;
  paidAt: Date | null;
}

export interface PaystackClient {
  initializeTransaction(input: InitializeInput): Promise<InitializeResult>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
}

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "PaystackError";
  }
}

const TIMEOUT_MS = 15_000;

export class HttpPaystackClient implements PaystackClient {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = "https://api.paystack.co",
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PaystackError(`Paystack unreachable: ${(err as Error).message}`, null);
    }
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
    if (!res.ok || !json?.status) {
      throw new PaystackError(json?.message ?? `Paystack returned ${res.status}`, res.status);
    }
    return json.data as T;
  }

  async initializeTransaction(input: InitializeInput): Promise<InitializeResult> {
    const data = await this.call<{ authorization_url: string; access_code: string; reference: string }>(
      "POST",
      "/transaction/initialize",
      {
        email: input.email,
        amount: input.amountKobo,
        currency: "NGN",
        reference: input.reference,
        channels: input.channels,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      },
    );
    return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    const data = await this.call<{
      id: number;
      status: string;
      reference: string;
      amount: number;
      currency: string;
      fees: number | null;
      channel: string | null;
      paid_at: string | null;
    }>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      id: data.id,
      status: data.status,
      reference: data.reference,
      amountKobo: Number(data.amount),
      currency: data.currency,
      feesKobo: data.fees === null || data.fees === undefined ? null : Number(data.fees),
      channel: data.channel ?? null,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
    };
  }
}

/**
 * Checks a webhook really came from Paystack: an HMAC-SHA512 of the raw body
 * with the secret key, hex-encoded in the x-paystack-signature header. Follows
 * Paystack's own sample (github.com/PaystackOSS/doc-code-snippets).
 */
export function isValidPaystackSignature(rawBody: Buffer, signature: unknown, secretKey: string): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
