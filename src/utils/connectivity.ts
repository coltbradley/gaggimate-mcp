function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      if (current.name) parts.push(current.name);
      if (current.message) parts.push(current.message);
      const code = (current as any).code;
      if (typeof code === "string" && code.trim()) {
        parts.push(code);
      }
      current = (current as any).cause;
      continue;
    }

    if (typeof current === "object") {
      const message = (current as any).message;
      if (typeof message === "string" && message.trim()) {
        parts.push(message);
      }
      const code = (current as any).code;
      if (typeof code === "string" && code.trim()) {
        parts.push(code);
      }
      current = (current as any).cause;
      continue;
    }

    if (typeof current === "string" && current.trim()) {
      parts.push(current);
    }
    break;
  }

  return parts.join(" ").trim();
}

export function isConnectivityError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  if (!text) return false;

  const markers = [
    "timeout",
    "aborted",
    "aborterror",
    "ehostunreach",
    "enetunreach",
    "ehostdown",
    "econnrefused",
    "enotfound",
    "eai_again",
    "network is unreachable",
    "fetch failed",
    "websocket error",
    "websocket closed",
  ];

  return markers.some((marker) => text.includes(marker));
}

/**
 * Returns true only for errors indicating the device is not network-reachable
 * (EHOSTUNREACH, ECONNREFUSED, etc.).  Timeouts are deliberately excluded so
 * that firmware bugs that cause HTTP fetches to hang (jniebuhr/gaggimate#650)
 * are not mistaken for the device being offline and don't suppress the
 * metadata fallback path.
 */
export function isReachabilityError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  if (!text) return false;

  const markers = [
    "ehostunreach",
    "enetunreach",
    "ehostdown",
    "econnrefused",
    "enotfound",
    "eai_again",
    "network is unreachable",
    "fetch failed",
    "websocket error",
    "websocket closed",
  ];

  return markers.some((marker) => text.includes(marker));
}

export function summarizeConnectivityError(error: unknown): string {
  const text = collectErrorText(error);
  if (!text) {
    return "unknown connectivity error";
  }

  const match = text.match(/\b(EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i);
  if (match?.[1]) {
    return match[1].toUpperCase();
  }

  if (/timeout|aborted|aborterror/i.test(text)) {
    return "timeout";
  }

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
