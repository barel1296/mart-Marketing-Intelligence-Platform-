/** Helpers for building safe, parameterized bulk statements. */

/** PostgreSQL hard-caps a statement at 65535 bind parameters. */
const MAX_BIND_PARAMS = 65535;

export function chunkRowsForBind<T>(rows: readonly T[], columnCount: number): T[][] {
  if (rows.length === 0) return [];
  const maxRows = Math.max(1, Math.floor(MAX_BIND_PARAMS / Math.max(1, columnCount)));
  // Keep batches well under the limit so a future column addition cannot break it.
  const batchSize = Math.min(maxRows, 500);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) out.push(rows.slice(i, i + batchSize));
  return out;
}

/** Build `($1,$2),($3,$4)` for `rowCount` rows of `columnCount` columns. */
export function valuesClause(rowCount: number, columnCount: number): string {
  const groups: string[] = [];
  let n = 1;
  for (let r = 0; r < rowCount; r += 1) {
    const placeholders: string[] = [];
    for (let c = 0; c < columnCount; c += 1) placeholders.push(`$${n++}`);
    groups.push(`(${placeholders.join(',')})`);
  }
  return groups.join(',');
}

/**
 * `SET col = EXCLUDED.col` list for an upsert.
 */
export function excludedAssignments(columns: readonly string[]): string {
  return columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
}

/**
 * Predicate that is true when any measure column actually changed.
 * Used to increment restatement_generation only on a real restatement, so a
 * no-op refresh is distinguishable from a provider revising its numbers.
 */
export function changedPredicate(table: string, columns: readonly string[]): string {
  return columns.map((c) => `${table}.${c} IS DISTINCT FROM EXCLUDED.${c}`).join(' OR ');
}
