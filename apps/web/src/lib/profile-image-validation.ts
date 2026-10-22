export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_DIMENSION = 10_000;
export const AVATAR_MAX_PIXELS = 40_000_000;
const acceptedMime = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateAvatarFile(type: string, size: number): 'type' | 'size' | null {
  if (!acceptedMime.has(type)) return 'type';
  if (!Number.isFinite(size) || size < 1 || size > AVATAR_MAX_BYTES) return 'size';
  return null;
}

export function avatarDimensionsSupported(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width >= 32 && height >= 32
    && width <= AVATAR_MAX_DIMENSION && height <= AVATAR_MAX_DIMENSION
    && width * height <= AVATAR_MAX_PIXELS;
}
