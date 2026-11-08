import { describe, expect, it } from "vitest";
import { margin, processorFee, quote } from "../src/payments/fees.js";

const naira = (n: number) => n * 100;
const card = { percent_bps: 390, flat_kobo: naira(100), cap_kobo: null, margin_bps: 0, margin_flat_kobo: 0 };
const transfer = { percent_bps: 100, flat_kobo: 0, cap_kobo: naira(300), margin_bps: 0, margin_flat_kobo: 0 };

describe("processor fee", () => {
  it("charges percent plus flat", () => {
    expect(processorFee(card, naira(10_000))).toBe(naira(390) + naira(100));
  });
  it("stops at the cap", () => {
    expect(processorFee(transfer, naira(1_000_000))).toBe(naira(300));
  });
});

describe("quotes", () => {
  it.each([
    // share, method, expected fee shown to the contributor (₦)
    [25_000, card, 1_119],
    [25_000, transfer, 253],
    [100_000, transfer, 300], // capped
    [1_000, card, 145],
  ])("₦%i by %#: fee ₦%i", (share, rates, fee) => {
    const q = quote(rates, naira(share));
    expect(q.feeKobo).toBe(naira(fee));
    expect(q.totalKobo).toBe(naira(share + fee));
  });

  it("add DettyPot's margin on top when one is set", () => {
    const withMargin = { ...transfer, margin_flat_kobo: naira(100) };
    const q = quote(withMargin, naira(25_000));
    expect(q.marginKobo).toBeGreaterThanOrEqual(naira(100));
    expect(q.totalKobo - q.expectedProcessorFeeKobo - q.marginKobo).toBe(naira(25_000));
  });

  // The two guarantees, checked across thousands of amounts and every schedule shape:
  // the pot always gets the full share, and the contributor never pays a naira more than needed.
  const schedules = [
    card,
    transfer,
    { percent_bps: 150, flat_kobo: naira(100), cap_kobo: naira(2_000), margin_bps: 0, margin_flat_kobo: 0 },
    { percent_bps: 150, flat_kobo: naira(100), cap_kobo: naira(2_000), margin_bps: 50, margin_flat_kobo: naira(20) },
    { percent_bps: 0, flat_kobo: 0, cap_kobo: null, margin_bps: 0, margin_flat_kobo: 0 },
  ];
  /** Every naira from ₦1,000 to ₦50,000, a sweep up to ₦2m, and every naira around where each cap starts to bite. */
  const sharesFor = (rates: (typeof schedules)[number]) => {
    const shares: number[] = [];
    for (let n = 1_000; n <= 50_000; n++) shares.push(naira(n));
    for (let n = 50_000; n <= 2_000_000; n += 997) shares.push(naira(n));
    if (rates.cap_kobo !== null) {
      // The cap bites once percent × total + flat reaches it.
      const capBites = Math.round(((rates.cap_kobo - rates.flat_kobo) * 10_000) / rates.percent_bps / 100);
      for (let n = capBites - 2_000; n <= capBites + 2_000; n++) if (n >= 1_000) shares.push(naira(n));
    }
    return shares;
  };

  it.each(schedules.map((s, i) => [i, s] as const))("schedule %i: always covers the share, never overcharges", (_i, rates) => {
    for (const share of sharesFor(rates)) {
      const needed = share + margin(rates, share);
      const { totalKobo } = quote(rates, share);
      const kept = (total: number) => total - processorFee(rates, total);

      expect(totalKobo % 100).toBe(0); // whole naira
      expect(kept(totalKobo)).toBeGreaterThanOrEqual(needed); // the pot gets the full share
      expect(kept(totalKobo - 100)).toBeLessThan(needed); // one naira less would fall short
    }
  });

  it("charge nothing extra when fees are switched off", () => {
    const free = { percent_bps: 0, flat_kobo: 0, cap_kobo: null, margin_bps: 0, margin_flat_kobo: 0 };
    expect(quote(free, naira(25_000))).toMatchObject({ feeKobo: 0, totalKobo: naira(25_000) });
  });
});
