/** Numeric percent text: retain small nominal shares without exposing multiplication noise. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number(value.toPrecision(12)).toString();
}
