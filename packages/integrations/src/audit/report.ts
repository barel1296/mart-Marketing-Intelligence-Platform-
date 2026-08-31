/**
 * Shared reporting primitives for MART's audit CLIs.
 *
 * An audit is only worth running if it can disagree with the thing it audits,
 * so every number it prints is derived from stored rows rather than read back
 * from the code under test. These helpers exist so several audits render the
 * same way and accumulate one verdict.
 */

/** How confident the audit is about one metric. */
export type Verdict = 'PASS' | 'FAIL' | 'UNPROVEN' | 'NOT_IMPLEMENTED';

/** Arithmetic must agree to here. Anything larger is a real difference. */
export const EPSILON = 1e-6;

export type AuditContext = {
  /** Every metric checked, in order, with its verdict. */
  results: Array<{ section: string; metric: string; verdict: Verdict; detail: string }>;
  section: string;
};

export function createContext(): AuditContext {
  return { results: [], section: 'general' };
}

export function heading(ctx: AuditContext, text: string): void {
  ctx.section = text;
  process.stdout.write(`\n=== ${text} ===\n`);
}

export function line(label: string, value: unknown): void {
  process.stdout.write(`${label.padEnd(34)} ${String(value)}\n`);
}

export function note(text: string): void {
  process.stdout.write(`  ${text}\n`);
}

/** Record a verdict reached by inspection rather than by arithmetic. */
export function record(ctx: AuditContext, metric: string, verdict: Verdict, detail: string): void {
  ctx.results.push({ section: ctx.section, metric, verdict, detail });
  process.stdout.write(`  ${metric.padEnd(30)} ${verdict.padEnd(16)} ${detail}\n`);
}

export function fmt(value: number | null): string {
  if (value === null) return '(unavailable)';
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}

/**
 * Compare independently computed values and record the verdict.
 *
 * `normalized` is what the stored rows say; `dashboard` is what the production
 * path produced; `derived` is the formula applied by hand. They must agree
 * exactly - a KPI that is only "about right" is a KPI nobody can act on.
 * Display rounding is the only difference tolerated, and it happens after this.
 */
export function compare(
  ctx: AuditContext,
  metric: string,
  normalized: number | null,
  dashboard: number | null,
  derived?: number | null,
): Verdict {
  const values = [normalized, dashboard, ...(derived === undefined ? [] : [derived])];
  const detail =
    `normalized=${fmt(normalized)} dashboard=${fmt(dashboard)}` +
    (derived === undefined ? '' : ` derived=${fmt(derived)}`);

  if (values.some((v) => v === null)) {
    ctx.results.push({ section: ctx.section, metric, verdict: 'UNPROVEN', detail });
    process.stdout.write(
      `  ${metric.padEnd(30)} ${'UNPROVEN'.padEnd(16)} ${detail} (a value is unavailable)\n`,
    );
    return 'UNPROVEN';
  }

  const numbers = values as number[];
  const difference = Math.max(...numbers) - Math.min(...numbers);
  const verdict: Verdict = difference <= EPSILON ? 'PASS' : 'FAIL';
  ctx.results.push({
    section: ctx.section,
    metric,
    verdict,
    detail: `${detail} diff=${difference.toExponential(2)}`,
  });
  process.stdout.write(
    `  ${metric.padEnd(30)} ${verdict.padEnd(16)} ${detail} diff=${difference.toExponential(2)}\n`,
  );
  return verdict;
}

/** Assert a boolean invariant that has no numeric comparison. */
export function assert(ctx: AuditContext, metric: string, ok: boolean, detail: string): void {
  record(ctx, metric, ok ? 'PASS' : 'FAIL', detail);
}

export function counts(ctx: AuditContext): Record<Verdict, number> {
  const out: Record<Verdict, number> = { PASS: 0, FAIL: 0, UNPROVEN: 0, NOT_IMPLEMENTED: 0 };
  for (const result of ctx.results) out[result.verdict] += 1;
  return out;
}
