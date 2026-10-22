export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(values: readonly unknown[]): Buffer { return Buffer.from(`${values.map(csvCell).join(',')}\r\n`, 'utf8'); }
