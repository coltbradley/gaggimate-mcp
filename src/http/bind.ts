/** Hosts that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const mapped = h.startsWith("::ffff:") ? h.slice(7) : h;
  return /^127(\.\d{1,3}){3}$/.test(mapped);
}

/** Refuse to expose the bridge beyond loopback without a token. */
export function assertSafeBind(host: string, apiToken: string): void {
  if (!apiToken && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to listen on ${host || "(empty)"} without API_TOKEN. ` +
      "Set API_TOKEN, or bind HTTP_HOST to 127.0.0.1.",
    );
  }
}
