import { createHash, createHmac, randomUUID } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const productionKey = key => key && !/^(1x|2x|3x)/.test(key);
export function smsSettings(env = process.env) {
  const settings = { enabled: env.ALIYUN_SMS_ENABLED === '1', accessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_SMS_ACCESS_KEY_SECRET,
    signName: env.ALIYUN_SMS_SIGN_NAME, templateCode: env.ALIYUN_SMS_TEMPLATE_CODE, pepper: env.SMS_CODE_PEPPER,
    siteKey: env.TURNSTILE_SITE_KEY, captchaSecret: env.TURNSTILE_SECRET_KEY, dailyLimit: Number(env.SMS_DAILY_LIMIT || 100) };
  settings.deliveryReady = !!(settings.enabled && settings.accessKeyId && settings.accessKeySecret && settings.signName && settings.templateCode && settings.pepper?.length >= 32);
  settings.captchaReady = !!(productionKey(settings.siteKey) && productionKey(settings.captchaSecret));
  settings.ready = settings.deliveryReady && settings.captchaReady;
  return settings;
}
// PNVS OpenAPI 2017-05-25, query parameters (per official SDK metadata),
// ACS3-HMAC-SHA256. Fixed HTTPS
// endpoint, no browser cookies, redirects, automatic retries or raw error logs.
export function aliyunAuthorization(settings, { headers, query, body = '' }) {
  const names = Object.keys(headers).sort(), signed = names.join(';');
  const canonical = `POST\n/\n${query}\n${names.map(name => name + ':' + headers[name].trim() + '\n').join('')}\n${signed}\n${sha(body)}`;
  const signature = createHmac('sha256', settings.accessKeySecret).update('ACS3-HMAC-SHA256\n' + sha(canonical)).digest('hex');
  return `ACS3-HMAC-SHA256 Credential=${settings.accessKeyId},SignedHeaders=${signed},Signature=${signature}`;
}
export function signedSmsRequest(settings, phone, code, outId, date = new Date(), nonce = randomUUID()) {
  const params = { PhoneNumber: phone.replace(/^\+86/, ''), CountryCode: '86', SignName: settings.signName, TemplateCode: settings.templateCode,
    TemplateParam: JSON.stringify({ code, min: '10' }), OutId: outId, ValidTime: '600', Interval: '60', ReturnVerifyCode: 'false', AutoRetry: '0' };
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const query = Object.keys(params).sort().map(key => encode(key) + '=' + encode(params[key])).join('&');
  const headers = { host: 'dypnsapi.aliyuncs.com', 'x-acs-action': 'SendSmsVerifyCode', 'x-acs-version': '2017-05-25',
    'x-acs-date': date.toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': nonce, 'x-acs-content-sha256': sha('') };
  return { url: 'https://dypnsapi.aliyuncs.com/?' + query, headers: { ...headers, Accept: 'application/json', Authorization: aliyunAuthorization(settings, { headers, query }) } };
}
export function createSmsProvider(settings, fetcher = fetch) {
  return {
    ready: settings.ready, deliveryReady: settings.deliveryReady ?? settings.ready, captchaReady: settings.captchaReady ?? settings.ready, pepper: settings.pepper, siteKey: settings.siteKey || '', dailyLimit: settings.dailyLimit,
    async verify(token, ip, hostname, action) {
      if (!settings.ready || typeof token !== 'string' || !token || token.length > 2048) return false;
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: settings.captchaSecret, response: token, remoteip: ip }), signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      return response.ok && result.success === true && result.hostname === hostname && result.action === action;
    },
    async send(phone, code, nonce) {
      if (!(settings.deliveryReady ?? settings.ready)) throw new Error('SmsDisabled');
      const request = signedSmsRequest(settings, phone, code, nonce);
      const response = await fetcher(request.url, { method: 'POST', redirect: 'error', credentials: 'omit', headers: request.headers, signal: AbortSignal.timeout(10000) });
      // Response data is deliberately discarded; it can contain provider diagnostics.
      const result = await response.json();
      if (!response.ok || result.Code !== 'OK' || result.Success !== true) throw new Error('SmsProviderRejected');
    },
  };
}
