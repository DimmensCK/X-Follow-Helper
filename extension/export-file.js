// Local export timestamps describe the download, not the last completed scan.
const sessionTag = crypto.randomUUID().slice(0, 8);
let sequence = 0;
const pad = (value, width = 2) => String(value).padStart(width, '0');

export function exportFileName(kind, date = new Date()) {
  if (!['data', 'table'].includes(kind)) throw new Error('INVALID_EXPORT_KIND');
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('INVALID_EXPORT_TIME');
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
  const offset = -date.getTimezoneOffset(), absolute = Math.abs(offset);
  const zone = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
  // Random document tag separates tabs; the counter also separates identical milliseconds.
  const unique = `${sessionTag}-${(++sequence).toString(36)}`;
  return `x-follow-${kind}-${day}_${clock}_${zone}_${unique}.${kind === 'data' ? 'json' : 'csv'}`;
}
