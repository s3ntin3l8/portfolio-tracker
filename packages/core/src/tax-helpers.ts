import { Decimal } from "decimal.js";
import { D, ZERO } from "./decimal.js";

export function effectiveMultiplier(tfRate: string | number): Decimal {
  return Decimal.max(ZERO, D(1).minus(D(tfRate)));
}

export function computePotUsage(subtotal: Decimal, carryForward: string | undefined): Decimal {
  const cf = Decimal.max(ZERO, D(carryForward ?? "0"));
  return Decimal.max(ZERO, subtotal.minus(cf));
}

export function positionHarvestMath(
  grossGain: Decimal,
  tfRateRaw: string | number | undefined,
  remaining: Decimal,
  taxRate: Decimal,
): {
  adjustedGain: Decimal;
  harvestableGross: Decimal;
  taxSaving: Decimal;
} {
  const tfRate = tfRateRaw !== undefined ? D(tfRateRaw) : ZERO;
  const ONE = D(1);
  const exemptFraction = Decimal.min(ONE, Decimal.max(ZERO, tfRate));
  const multiplier = ONE.minus(exemptFraction);

  let adjustedGain: Decimal;
  let harvestableGross: Decimal;

  if (multiplier.isZero()) {
    adjustedGain = ZERO;
    harvestableGross = grossGain;
  } else {
    adjustedGain = grossGain.times(multiplier);
    const maxGross = remaining.div(multiplier);
    harvestableGross = Decimal.min(grossGain, maxGross);
  }

  const adjustedCapped = Decimal.min(adjustedGain, remaining);
  const taxSaving = adjustedCapped.times(taxRate);

  return { adjustedGain, harvestableGross, taxSaving };
}
