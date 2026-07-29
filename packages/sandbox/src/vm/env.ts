
export function buildGuestEnv(
  specEnv: Record<string, string> | undefined,
  guestProxyAddr: string,
  caBundlePath: string,
): string[] {
  const merged: Record<string, string> = { ...specEnv };
  // Trusted overrides (applied AFTER spec.env so they win on collision):
  merged.HTTP_PROXY = guestProxyAddr;
  merged.HTTPS_PROXY = guestProxyAddr;
  merged.http_proxy = guestProxyAddr;
  merged.https_proxy = guestProxyAddr;
  merged.ALL_PROXY = guestProxyAddr;
  merged.all_proxy = guestProxyAddr;
  merged.NO_PROXY = '';
  merged.no_proxy = '';
  merged.SSL_CERT_FILE = caBundlePath;
  merged.NODE_EXTRA_CA_CERTS = caBundlePath;
  merged.REQUESTS_CA_BUNDLE = caBundlePath;
  return Object.entries(merged).map(([k, v]) => `${k}=${v}`);
}
