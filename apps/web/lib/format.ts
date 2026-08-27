export function formatMetric(value: number | null, format: string, currency = 'USD'): string {
  if (value === null || Number.isNaN(value)) return '—';
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: value >= 100 ? 0 : 2,
      }).format(value);
    case 'percent':
      return `${(value * 100).toFixed(2)}%`;
    case 'integer':
      return new Intl.NumberFormat('en-US').format(Math.round(value));
    case 'ratio':
      return value.toFixed(2);
    default:
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  }
}

export function formatCompact(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'never';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Map a MART state onto a status chip class. */
export function statusTone(status: string | null | undefined): string {
  switch (status) {
    case 'fresh':
    case 'connected':
    case 'available':
    case 'completed':
    case 'matched_exact':
    case 'manually_verified':
      return 'chip-good';
    case 'delayed':
    case 'partial':
    case 'partially_completed':
    case 'pending':
    case 'matched_fallback':
      return 'chip-warning';
    case 'stale':
    case 'degraded':
    case 'ambiguous':
    case 'serious':
      return 'chip-serious';
    case 'error':
    case 'failed':
    case 'invalid_credentials':
    case 'disconnected':
    case 'unavailable':
      return 'chip-critical';
    default:
      return 'chip-neutral';
  }
}
