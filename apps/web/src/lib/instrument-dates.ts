export function getExpirationStatus(value: string | null | undefined, now = new Date()) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const match = value.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const expiryDay = Date.UTC(year, month - 1, day);
  const checked = new Date(expiryDay);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) return undefined;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.floor((expiryDay - today) / 86_400_000);
  if (days < 0) return { expired: true as const, days };
  if (days <= 7) return { expired: false as const, days };
  return undefined;
}
