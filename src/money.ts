/** All money in Remit is integer cents. Dollars only appear at the edges (tool inputs, PayPal values, display). */

export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error(`Not a number: ${dollars}`);
  return Math.round(dollars * 100);
}

/** PayPal's string form, e.g. 1234 -> "12.34". */
export function toValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fromValue(value: string): number {
  return toCents(Number(value));
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
