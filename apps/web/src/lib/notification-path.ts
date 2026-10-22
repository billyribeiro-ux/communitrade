/** Notification targets are same-origin routes that are already public or part of the member workspace. */
export function safeNotificationHref(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/app";
  try {
    const parsed = new URL(value, "https://workspace.invalid");
    if (parsed.origin !== "https://workspace.invalid") return "/app";
    return parsed.pathname.startsWith("/app/") || parsed.pathname.startsWith("/ideas/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/app";
  } catch { return "/app"; }
}
