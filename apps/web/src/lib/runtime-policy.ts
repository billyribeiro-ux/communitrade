export function usesLocalSessionCookie(releaseMode: string | undefined, nodeEnv: string | undefined): boolean {
  const mode = releaseMode?.toLowerCase();
  return mode === "local" || (mode !== "public" && mode !== "production" && nodeEnv !== "production");
}
