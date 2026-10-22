/** Spreadsheet-safe CSV encoding for text and serialized raw-record values. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  // Excel and other spreadsheet apps may ignore leading spaces/control characters
  // before interpreting a formula. Prefix the original value when that is possible.
  if (/^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvDocument(headers: readonly string[], rows: readonly (readonly unknown[])[]): Buffer {
  const lines = [headers.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))];
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}
