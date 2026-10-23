const productionKey = value => typeof value === 'string' && !!value && !/^(1x|2x|3x)/.test(value);
export function createCaptchaProvider(env = process.env, fetcher = fetch) {
  const ready = productionKey(env.TURNSTILE_SITE_KEY) && productionKey(env.TURNSTILE_SECRET_KEY);
  return {
    ready, siteKey: ready ? env.TURNSTILE_SITE_KEY : '',
    async verify(token, ip, hostname, action) {
      if (!ready || typeof token !== 'string' || !token || token.length > 2048) return false;
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      return response.ok && result.success === true && result.hostname === hostname && result.action === action;
    },
  };
}
