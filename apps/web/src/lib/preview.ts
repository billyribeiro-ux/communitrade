/** Synthetic fixtures are available only when a developer explicitly opts into the local design preview. */
export function isLocalPreview(): boolean {
  return process.env.RELEASE_MODE !== 'production' && process.env.LOCAL_DESIGN_PREVIEW === '1';
}
