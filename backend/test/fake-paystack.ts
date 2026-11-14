import { createHmac } from "node:crypto";
import type {
  Bank,
  InitializeInput,
  InitializeResult,
  PaystackClient,
  RefundResult,
  ResolvedAccount,
  TransferInput,
  TransferResult,
  VerifiedTransaction,
} from "../src/payments/paystack.js";
import { PaystackError } from "../src/payments/paystack.js";

interface FakeTransaction {
  id: number;
  input: InitializeInput;
  status: "pending" | "success" | "failed" | "abandoned" | "reversed";
  amountKobo: number;
  currency: string;
  feesKobo: number | null;
  channel: string | null;
  paidAt: Date | null;
}

/** Paystack's default fees, the way the launch fee schedules model them. */
const defaultFee = (channel: string, amount: number) =>
  channel === "card" ? Math.ceil((amount * 390) / 10_000) + 10_000 : Math.min(Math.ceil(amount / 100), 30_000);

/**
 * Stands in for Paystack in tests: remembers started checkouts, lets a test
 * "pay" them (rightly or wrongly), and signs webhooks with the secret key
 * exactly as Paystack does.
 */
export class FakePaystack implements PaystackClient {
  readonly secretKey = "sk_test_fakepaystacksecret";
  readonly transactions = new Map<string, FakeTransaction>();
  failInitialize = false;
  /** Number of upcoming verify calls that fail as if the network were down. */
  verifyOutages = 0;
  private nextId = 1000;

  async initializeTransaction(input: InitializeInput): Promise<InitializeResult> {
    if (this.failInitialize) throw new PaystackError("Service unavailable", 503);
    this.transactions.set(input.reference, {
      id: this.nextId++,
      input,
      status: "pending",
      amountKobo: input.amountKobo,
      currency: "NGN",
      feesKobo: null,
      channel: null,
      paidAt: null,
    });
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, accessCode: `ac_${input.reference}`, reference: input.reference };
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    if (this.verifyOutages > 0) {
      this.verifyOutages--;
      throw new PaystackError("Paystack unreachable: simulated outage", null);
    }
    const t = this.transactions.get(reference);
    if (!t) throw new PaystackError("Transaction reference not found", 404);
    return { id: t.id, status: t.status, reference, amountKobo: t.amountKobo, currency: t.currency, feesKobo: t.feesKobo, channel: t.channel, paidAt: t.paidAt };
  }

  /** The member completes payment at Paystack. Options let a test pay the wrong amount, and so on. */
  pay(reference: string, opts: { amountKobo?: number; currency?: string; feesKobo?: number | null; status?: FakeTransaction["status"] } = {}) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`no checkout for ${reference}`);
    t.status = opts.status ?? "success";
    t.amountKobo = opts.amountKobo ?? t.input.amountKobo;
    t.currency = opts.currency ?? "NGN";
    t.channel = t.input.channels[0] ?? "card";
    t.feesKobo = opts.feesKobo === undefined ? defaultFee(t.channel, t.amountKobo) : opts.feesKobo;
    t.paidAt = new Date();
    return this.webhook("charge.success", { reference, amount: t.amountKobo, currency: t.currency, status: t.status, fees: null });
  }

  // ─── Transfers ───

  readonly banks: Bank[] = [
    { id: 9, name: "Guaranty Trust Bank", code: "058" },
    { id: 1, name: "Access Bank", code: "044" },
    { id: 171, name: "OPay Digital Services Limited (OPay)", code: "999992" },
  ];
  /** Accounts the fake "bank system" knows, by `${bankCode}:${accountNumber}`. */
  readonly accounts = new Map<string, string>();
  readonly transfers = new Map<string, TransferInput & { status: string; transferCode: string; feeKobo: number | null }>();
  initiateCalls = 0;
  /** How the next transfer request goes. */
  transferMode: "pending" | "otp" | "insufficient_balance" | "outage" | "rate_limited" = "pending";
  /** When true, account lookups are turned away with a 429, like test mode's daily limit. */
  resolveRateLimited = false;
  /** How setting up a transfer recipient goes. */
  recipientMode: "ok" | "refuse" | "rate_limited" = "ok";
  private nextRecipient = 1;

  addAccount(bankCode: string, accountNumber: string, name: string) {
    this.accounts.set(`${bankCode}:${accountNumber}`, name);
  }

  async listBanks(): Promise<Bank[]> {
    return this.banks;
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    if (this.resolveRateLimited) throw new PaystackError("Too many requests: slow down", 429);
    const name = this.accounts.get(`${bankCode}:${accountNumber}`);
    if (!name) throw new PaystackError("Could not resolve account name. Check parameters or try again.", 422);
    return { accountNumber, accountName: name };
  }

  async createTransferRecipient(): Promise<string> {
    if (this.recipientMode === "refuse") throw new PaystackError("Cannot resolve account", 400);
    if (this.recipientMode === "rate_limited") throw new PaystackError("Too many requests: slow down", 429);
    return `RCP_${this.nextRecipient++}`;
  }

  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    this.initiateCalls++;
    if (this.transferMode === "outage") throw new PaystackError("Paystack unreachable: simulated outage", null);
    if (this.transferMode === "rate_limited") throw new PaystackError("Too many requests: slow down", 429);
    if (this.transferMode === "insufficient_balance") throw new PaystackError("Your balance is not enough to fulfil this request", 400);
    // Paystack treats the reference as an idempotency key: the same one returns the same transfer.
    const existing = this.transfers.get(input.reference);
    if (existing) return this.result(existing);
    const t = { ...input, status: this.transferMode === "otp" ? "otp" : "pending", transferCode: `TRF_${input.reference}`, feeKobo: null };
    this.transfers.set(input.reference, t);
    return this.result(t);
  }

  async verifyTransfer(reference: string): Promise<TransferResult> {
    if (this.verifyOutages > 0) {
      this.verifyOutages--;
      throw new PaystackError("Paystack unreachable: simulated outage", null);
    }
    const t = this.transfers.get(reference);
    if (!t) throw new PaystackError("Transfer not found", 404);
    return this.result(t);
  }

  private result(t: { status: string; transferCode: string; reference: string; amountKobo: number; feeKobo: number | null }): TransferResult {
    return { status: t.status, transferCode: t.transferCode, reference: t.reference, amountKobo: t.amountKobo, feeKobo: t.feeKobo };
  }

  // ─── Refunds ───

  readonly refunds = new Map<
    number,
    { transactionReference: string; amountKobo: number; status: string; merchantNote: string; account?: { accountNumber: string; bankId: number } }
  >();
  /** When set, the next refund is created at Paystack but the reply never arrives. */
  loseNextRefundReply = false;
  /** How new refunds start out: most go straight to pending; bank transfers may need the customer's account. */
  refundMode: "pending" | "needs-attention" | "reject" | "rate_limited" = "pending";
  private nextRefund = 5000;

  async createRefund(input: { transactionReference: string; amountKobo: number; merchantNote: string }): Promise<RefundResult> {
    if (this.refundMode === "reject") throw new PaystackError("Refund cannot be processed for this transaction", 400);
    if (this.refundMode === "rate_limited") throw new PaystackError("Too many requests: slow down", 429);
    const tx = this.transactions.get(input.transactionReference);
    if (!tx || tx.status !== "success") throw new PaystackError("Transaction not found or not successful", 400);
    const id = this.nextRefund++;
    this.refunds.set(id, { transactionReference: input.transactionReference, amountKobo: input.amountKobo, status: this.refundMode, merchantNote: input.merchantNote });
    if (this.loseNextRefundReply) {
      this.loseNextRefundReply = false;
      throw new PaystackError("Paystack unreachable: reply lost", null);
    }
    return this.refundResult(id);
  }

  async fetchRefund(id: number): Promise<RefundResult> {
    if (this.verifyOutages > 0) {
      this.verifyOutages--;
      throw new PaystackError("Paystack unreachable: simulated outage", null);
    }
    if (!this.refunds.has(id)) throw new PaystackError("Refund not found", 404);
    return this.refundResult(id);
  }

  async listTransactions() {
    return [...this.transactions.entries()].map(([reference, t]) => ({ reference, status: t.status, amountKobo: t.amountKobo, currency: t.currency }));
  }

  async listTransfers() {
    return [...this.transfers.entries()].map(([reference, t]) => ({ reference, status: t.status, amountKobo: t.amountKobo }));
  }

  async listRefundsSince(): Promise<(RefundResult & { merchantNote: string | null })[]> {
    return [...this.refunds.keys()].map((id) => ({ ...this.refundResult(id), merchantNote: this.refunds.get(id)!.merchantNote }));
  }

  async retryRefundWithAccount(id: number, account: { accountNumber: string; bankId: number }): Promise<RefundResult> {
    const r = this.refunds.get(id);
    if (!r) throw new PaystackError("Refund not found", 404);
    r.account = account;
    r.status = "processing";
    return this.refundResult(id);
  }

  private refundResult(id: number): RefundResult {
    const r = this.refunds.get(id)!;
    return { id, status: r.status, amountKobo: r.amountKobo, deductedKobo: r.amountKobo };
  }

  /** Finds the refund Paystack made for a payment. */
  refundFor(transactionReference: string) {
    const entry = [...this.refunds.entries()].find(([, r]) => r.transactionReference === transactionReference);
    return entry ? { id: entry[0], ...entry[1] } : undefined;
  }

  /** The refund completes (or fails) at Paystack; returns the signed webhook about it. */
  finishRefund(id: number, status: "processed" | "failed") {
    const r = this.refunds.get(id)!;
    r.status = status;
    return this.webhook(`refund.${status}`, {
      status,
      transaction_reference: r.transactionReference,
      refund_reference: `RFN${id}`,
      amount: String(r.amountKobo), // Paystack's sample sends this one as a string
      currency: "NGN",
    });
  }

  /** The bank finishes the transfer; returns Paystack's signed webhook about it. */
  finishTransfer(reference: string, status: "success" | "failed" | "reversed" | "blocked" | "rejected" | "abandoned", feeKobo = 2_500) {
    const t = this.transfers.get(reference);
    if (!t) throw new Error(`no transfer ${reference}`);
    t.status = status;
    t.feeKobo = feeKobo;
    return this.webhook(`transfer.${status}`, {
      reference,
      amount: t.amountKobo,
      currency: "NGN",
      status,
      transfer_code: t.transferCode,
      fee_charged: feeKobo,
    });
  }

  /** A signed webhook, as Paystack would send it. */
  webhook(event: string, data: Record<string, unknown>) {
    const body = JSON.stringify({ event, data });
    return { body, signature: createHmac("sha512", this.secretKey).update(body).digest("hex") };
  }
}
