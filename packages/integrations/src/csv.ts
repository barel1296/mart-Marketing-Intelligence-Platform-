/**
 * Minimal RFC 4180 CSV reader.
 *
 * AppsFlyer's Pull API returns CSV, so MART needs a parser that handles quoted
 * fields containing commas, quotes and newlines. Written here rather than added
 * as a dependency because the surface needed is small and fully testable.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM if present; providers emit it inconsistently.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type CsvTable = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

/**
 * Parse CSV into records keyed by header.
 *
 * Header names are normalized to snake_case so a provider changing display
 * casing does not break mapping, but the original header list is preserved for
 * schema-change detection.
 */
export function parseCsvTable(input: string): CsvTable {
  const raw = parseCsv(input).filter((r) => r.length > 1 || (r[0] ?? '').trim().length > 0);
  if (raw.length === 0) return { headers: [], rows: [] };
  const headerRow = raw[0] ?? [];
  const headers = headerRow.map((h) => h.trim());
  const keys = headers.map(normalizeHeader);
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < raw.length; r += 1) {
    const values = raw[r] ?? [];
    const record: Record<string, string> = {};
    for (let c = 0; c < keys.length; c += 1) {
      const key = keys[c];
      if (!key) continue;
      record[key] = (values[c] ?? '').trim();
    }
    rows.push(record);
  }
  return { headers, rows };
}

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function csvNumber(value: string | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function csvOptionalNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function csvText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
