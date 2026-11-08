import type { Selectable } from "kysely";
import type { Database, Db } from "../db/index.js";

export type FeeSchedule = Selectable<Database["fee_schedules"]>;
export type PaymentMethod = "card" | "bank_transfer";
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["card", "bank_transfer"];

type Rates = Pick<FeeSchedule, "percent_bps" | "flat_kobo" | "cap_kobo" | "margin_bps" | "margin_flat_kobo">;

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);
const roundUpToNaira = (kobo: number) => ceilDiv(kobo, 100) * 100;

/** What the processor takes from a charge of `totalKobo` (it charges on the whole amount paid). */
export function processorFee(rates: Rates, totalKobo: number): number {
  const fee = ceilDiv(totalKobo * rates.percent_bps, 10_000) + rates.flat_kobo;
  return rates.cap_kobo === null ? fee : Math.min(fee, rates.cap_kobo);
}

/** DettyPot's own margin on a share. */
export function margin(rates: Rates, shareKobo: number): number {
  return ceilDiv(shareKobo * rates.margin_bps, 10_000) + rates.margin_flat_kobo;
}

export interface Quote {
  shareKobo: number;
  feeKobo: number;
  totalKobo: number;
  /** What we expect the processor to keep; the ledger records what it actually kept. */
  expectedProcessorFeeKobo: number;
  marginKobo: number;
}

/**
 * The smallest whole-naira total such that, after the processor takes its fee
 * from the whole amount, the pot still receives the full share and DettyPot its
 * margin. The fee shown to the contributor is total minus share.
 */
export function quote(rates: Rates, shareKobo: number): Quote {
  const needed = shareKobo + margin(rates, shareKobo);
  // Smallest total with total × (1 − p) − flat ≥ needed. This is exact, not an
  // estimate: the processor rounds its percentage up, which only makes the true
  // condition stricter, and what is kept (total − fee) never falls as the total
  // rises. So rounding up to the naira covers the share, and one naira less
  // never does. test/fees.test.ts checks this for every naira up to ₦50,000.
  let total = roundUpToNaira(ceilDiv((needed + rates.flat_kobo) * 10_000, 10_000 - rates.percent_bps));
  // Past the cap the fee is fixed, so the total is simply what's needed plus the cap.
  if (rates.cap_kobo !== null && processorFee(rates, total) >= rates.cap_kobo) {
    total = roundUpToNaira(needed + rates.cap_kobo);
  }

  return {
    shareKobo,
    feeKobo: total - shareKobo,
    totalKobo: total,
    expectedProcessorFeeKobo: processorFee(rates, total),
    marginKobo: total - shareKobo - processorFee(rates, total),
  };
}

/** The schedule in force now for a payment method: the newest one already effective. */
export async function currentSchedule(db: Db, method: PaymentMethod, now = new Date()): Promise<FeeSchedule> {
  return db
    .selectFrom("fee_schedules")
    .selectAll()
    .where("method", "=", method)
    .where("effective_from", "<=", now)
    .orderBy("effective_from", "desc")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
}
