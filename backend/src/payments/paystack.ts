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

export interface Bank {
  name: string;
  code: string;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
}

export interface TransferInput {
  amountKobo: number;
  recipientCode: string;
  /** Lowercase letters, digits, - and _; makes the transfer idempotent at Paystack. */
  reference: string;
  reason: string;
}

export interface TransferResult {
  /** e.g. pending, received, success, failed, reversed, otp */
  status: string;
  transferCode: string | null;
  reference: string;
  amountKobo: number;
  feeKobo: number | null;
}

export interface PaystackClient {
  initializeTransaction(input: InitializeInput): Promise<InitializeResult>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  /** Nigerian banks that can receive transfers. */
  listBanks(): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount>;
  createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<string>;
  initiateTransfer(input: TransferInput): Promise<TransferResult>;
  verifyTransfer(reference: string): Promise<TransferResult>;
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

  async listBanks(): Promise<Bank[]> {
    const data = await this.call<{ name: string; code: string; active: boolean; supports_transfer?: boolean; is_deleted?: boolean }[]>(
      "GET",
      "/bank?country=nigeria&currency=NGN&perPage=500",
    );
    return data.filter((b) => b.active && !b.is_deleted && b.supports_transfer !== false).map((b) => ({ name: b.name, code: b.code }));
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    const data = await this.call<{ account_number: string; account_name: string }>(
      "GET",
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    return { accountNumber: data.account_number, accountName: data.account_name };
  }

  async createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<string> {
    const data = await this.call<{ recipient_code: string }>("POST", "/transferrecipient", {
      type: "nuban",
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: "NGN",
    });
    return data.recipient_code;
  }

  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    const data = await this.call<TransferData>("POST", "/transfer", {
      source: "balance",
      amount: input.amountKobo,
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
      currency: "NGN",
    });
    return toTransfer(data);
  }

  async verifyTransfer(reference: string): Promise<TransferResult> {
    return toTransfer(await this.call<TransferData>("GET", `/transfer/verify/${encodeURIComponent(reference)}`));
  }
}

interface TransferData {
  status: string;
  transfer_code?: string | null;
  reference: string;
  amount: number | string;
  fee_charged?: number | string | null;
}

const toTransfer = (d: TransferData): TransferResult => ({
  status: d.status,
  transferCode: d.transfer_code ?? null,
  reference: d.reference,
  amountKobo: Number(d.amount),
  feeKobo: d.fee_charged === null || d.fee_charged === undefined ? null : Number(d.fee_charged),
});

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
