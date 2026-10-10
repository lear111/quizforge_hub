import { createHash, createHmac } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const productionKey = key => key && !/^(1x|2x|3x)/.test(key);

export function mailSettings(env = process.env) {
  const settings = {
    enabled: env.TENCENT_SES_ENABLED === '1', secretId: env.TENCENT_SECRET_ID,
    secretKey: env.TENCENT_SECRET_KEY, region: env.TENCENT_SES_REGION || 'ap-hongkong',
    from: env.TENCENT_SES_FROM, templateId: Number(env.TENCENT_SES_TEMPLATE_ID),
    pepper: env.EMAIL_CODE_PEPPER, siteKey: env.TURNSTILE_SITE_KEY, captchaSecret: env.TURNSTILE_SECRET_KEY,
  };
  settings.ready = !!(settings.enabled && settings.secretId && settings.secretKey && settings.from &&
    ['ap-hongkong', 'ap-guangzhou'].includes(settings.region) && Number.isSafeInteger(settings.templateId) && settings.templateId > 0 &&
    settings.pepper?.length >= 32 && productionKey(settings.siteKey) && productionKey(settings.captchaSecret));
  return settings;
}

// TC3 signing follows Tencent's v3 specification; credentials never leave this backend.
export function signedEmailRequest(settings, email, code, timestamp = Math.floor(Date.now() / 1000)) {
  const host = 'ses.tencentcloudapi.com';
  const payload = JSON.stringify({ FromEmailAddress: `QuizForge <${settings.from}>`, Destination: [email],
    Subject: 'QuizForge 注册验证码', Template: { TemplateID: settings.templateId, TemplateData: JSON.stringify({ code }) }, TriggerType: 1 });
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:sendemail\n\n${signedHeaders}\n${sha(payload)}`;
  const scope = `${date}/ses/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`;
  const signingKey = hmac(hmac(hmac(`TC3${settings.secretKey}`, date), 'ses'), 'tc3_request');
  return { url: `https://${host}/`, body: payload, headers: {
    'Content-Type': 'application/json; charset=utf-8', Host: host,
    Authorization: `TC3-HMAC-SHA256 Credential=${settings.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, 'hex')}`,
    'X-TC-Action': 'SendEmail', 'X-TC-Version': '2020-10-02', 'X-TC-Region': settings.region, 'X-TC-Timestamp': String(timestamp),
  } };
}

export function createMailProvider(settings, fetcher = fetch) {
  return {
    ready: settings.ready, pepper: settings.pepper, siteKey: settings.ready ? settings.siteKey : '',
    async verify(token, ip, hostname) {
      if (!settings.ready || typeof token !== 'string' || !token || token.length > 2048) return false;
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: settings.captchaSecret, response: token, remoteip: ip }), signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      return response.ok && result.success === true && result.action === 'register_email' && result.hostname === hostname;
    },
    async send(email, code) {
      if (!settings.ready) throw new Error('MailDisabled');
      const request = signedEmailRequest(settings, email, code);
      const response = await fetcher(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(10000) });
      const result = (await response.json()).Response;
      if (!response.ok || result?.Error || !result?.MessageId) throw new Error('MailProviderRejected');
      return result.MessageId;
    },
  };
}
