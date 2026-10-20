import { randomBytes, createHash } from 'node:crypto';
import { CloudError } from './accounts.mjs';

const fresh = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function cookie(req, name) {
  const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return values.length === 1 && opaque(values[0].slice(name.length + 1)) ? values[0].slice(name.length + 1) : null;
}

// Sessions and the original Hub credential remain in process memory only. A
// restart repeats the short Hub sign-in handoff; no production DB is opened.
export class HubLogin {
  constructor({ practiceOrigin, hubOrigin, authPort = 4318, now = Date.now, secure = true }) {
    this.practice = new URL(practiceOrigin); this.hub = new URL(hubOrigin); this.authPort = authPort; this.now = now; this.secure = secure;
    this.pending = new Map(); this.codes = new Map(); this.sessions = new Map(); this.starts = new Map();
  }
  sweep() {
    for (const map of [this.pending, this.codes, this.sessions, this.starts]) for (const [key, entry] of map) if (entry.expires <= this.now()) map.delete(key);
  }
  setCookie(name, token, seconds) { return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`; }
  async identity(token) {
    if (!opaque(token)) return null;
    const result = await fetch(`http://127.0.0.1:${this.authPort}/api/me`, {
      headers: { Cookie: 'qfh_session=' + token }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new CloudError(503, 'Hub 登录服务暂时不可用，请稍后重试');
    const { user } = await result.json();
    if (!user) return null;
    if (!/^[a-f0-9-]{36}$/.test(user.id) || typeof user.name !== 'string' || user.name.length > 200 || typeof user.email !== 'string' || user.email.length > 200 || ![0, 1].includes(user.admin)) throw new CloudError(503, 'Hub 登录响应无效');
    return { id: user.id, name: user.name, email: user.email, admin: user.admin };
  }
  async resolve(req) {
    this.sweep();
    const raw = cookie(req, '__Host-qfh_practice'), session = raw && this.sessions.get(hash(raw));
    if (!session) return null;
    const user = await this.identity(session.hubToken);
    if (!user || user.id !== session.userId) { this.sessions.delete(hash(raw)); return null; }
    return user;
  }
  async handle(req, res, url) {
    this.sweep();
    const host = req.headers.host;
    if (![this.practice.host, this.hub.host].includes(host)) throw new CloudError(403, '访问地址无效');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      req.resume(); res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(req.method === 'HEAD' ? '' : body); return true;
    };
    const redirect = target => { req.resume(); res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(); return true; };
    if (host === this.hub.host) {
      if (!['GET', 'HEAD'].includes(req.method)) throw new CloudError(405, '登录跳转仅支持 GET');
      if (url.pathname === '/practice-auth/login.js') return send(200, loginScript, 'text/javascript; charset=utf-8');
      if (url.pathname === '/practice-auth/login.css') return send(200, loginStyle, 'text/css; charset=utf-8');
      if (url.pathname !== '/practice-auth/authorize') throw new CloudError(404, '页面不存在');
      const request = url.searchParams.get('request'), pending = opaque(request) && this.pending.get(request);
      if (!pending) return send(400, '<!doctype html><meta charset="utf-8"><title>登录已过期</title><p>登录请求已过期。</p><a href="' + this.practice.origin + '/auth/hub">返回刷题页重新登录</a>');
      const token = cookie(req, 'qfh_session'), user = await this.identity(token);
      if (!user) return send(200, loginPage(this.hub.origin));
      if (this.codes.size >= 10000) throw new CloudError(503, '登录请求较多，请稍后重试');
      if (pending.code) this.codes.delete(pending.code);
      const code = fresh(); pending.code = hash(code);
      this.codes.set(hash(code), { request, hubToken: token, userId: user.id, expires: this.now() + 60000 });
      return redirect(`${this.practice.origin}/auth/callback?code=${code}&state=${request}`);
    }
    if (url.pathname === '/auth/hub') {
      if (req.method !== 'GET') throw new CloudError(405, '登录跳转仅支持 GET');
      const address = String(req.headers['x-real-ip'] || req.socket.remoteAddress), budget = this.starts.get(address) || { count: 0, expires: this.now() + 60000 };
      if (++budget.count > 30 || this.pending.size >= 10000 || this.sessions.size >= 10000) throw new CloudError(429, '登录请求过于频繁，请稍后重试');
      this.starts.set(address, budget);
      const request = fresh(), verifier = fresh(); this.pending.set(request, { verifier: hash(verifier), expires: this.now() + 600000 });
      res.setHeader('Set-Cookie', this.setCookie('__Host-qfh_practice_login', verifier, 600));
      return redirect(`${this.hub.origin}/practice-auth/authorize?request=${request}`);
    }
    if (url.pathname === '/auth/callback') {
      if (req.method !== 'GET') throw new CloudError(405, '登录回调仅支持 GET');
      const code = url.searchParams.get('code'), state = url.searchParams.get('state'), verifier = cookie(req, '__Host-qfh_practice_login');
      const issued = opaque(code) && this.codes.get(hash(code)), pending = opaque(state) && this.pending.get(state);
      if (!issued || !pending || issued.request !== state || !verifier || hash(verifier) !== pending.verifier) throw new CloudError(400, '登录校验失败，请从刷题页重新登录');
      this.codes.delete(hash(code)); this.pending.delete(state);
      const user = await this.identity(issued.hubToken);
      if (!user || user.id !== issued.userId) throw new CloudError(401, 'Hub 登录已失效，请重新登录');
      const token = fresh(); this.sessions.set(hash(token), { hubToken: issued.hubToken, userId: user.id, expires: this.now() + 12 * 3600000 });
      res.setHeader('Set-Cookie', [this.setCookie('__Host-qfh_practice', token, 12 * 3600), this.setCookie('__Host-qfh_practice_login', '', 0)]);
      return redirect('/');
    }
    if (url.pathname === '/auth/logout') {
      if (req.method !== 'POST' || req.headers.origin !== this.practice.origin) throw new CloudError(403, '请求来源无效');
      const token = cookie(req, '__Host-qfh_practice'), session = token && this.sessions.get(hash(token));
      if (session) {
        const response = await fetch(`http://127.0.0.1:${this.authPort}/api/auth/logout`, { method: 'POST', headers: { Cookie: 'qfh_session=' + session.hubToken, Origin: this.hub.origin }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new CloudError(503, '暂时未能退出 Hub，请稍后重试');
        await response.body?.cancel(); this.sessions.delete(hash(token));
      }
      res.setHeader('Set-Cookie', this.setCookie('__Host-qfh_practice', '', 0));
      return send(200, '{"ok":true}', 'application/json; charset=utf-8');
    }
    if (url.pathname.startsWith('/auth/')) throw new CloudError(404, '登录接口不存在');
    return false;
  }
}

const loginScript = `const form=document.querySelector('form');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button'),error=document.querySelector('[role=alert]');button.disabled=true;error.textContent='';try{const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.elements.email.value,password:form.elements.password.value})});form.elements.password.value='';if(response.ok){location.replace(location.pathname+location.search);return;}error.textContent=response.status===429?'尝试次数较多，请稍后重试。':'登录失败，请检查邮箱和密码。';}catch{error.textContent='连接失败，请稍后重试。';}finally{button.disabled=false;}});`;
function loginPage(hubOrigin) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · QuizForge Hub</title><link rel="stylesheet" href="/practice-auth/login.css"><script defer src="/practice-auth/login.js"></script></head><body><main><section class="panel"><img class="brand" src="/quizforge-icon.png" width="46" height="46" alt="QuizForge"><h1>登录 QuizForge Hub</h1><p>登录后直接进入你的云端刷题空间。</p><form><label>邮箱<input name="email" type="email" autocomplete="username" maxlength="180" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><p class="error" role="alert"></p><button type="submit">登录并开始刷题</button></form><p class="register">还没有账号？<a href="${hubOrigin}/manage/#library" target="_blank" rel="noopener noreferrer">前往 Hub 注册</a>，完成后回到本页登录。</p></section></main></body></html>`;
}
const loginStyle = `*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;color:#42354f;background:linear-gradient(145deg,#e4def6,#f8e9ed 65%,#ded5f1)}main{width:min(420px,100%)}.panel{padding:34px;border:1px solid #eee7f6;border-radius:22px;background:#fffffff0;box-shadow:0 20px 80px #6d468520}.brand{border-radius:12px}h1{margin:16px 0 4px;font-size:23px}p{color:#84768f;margin:0 0 22px}form{display:grid;gap:16px}label{display:grid;gap:7px;font-weight:550}input{width:100%;font:inherit;padding:11px 12px;border:1px solid #ded4eb;border-radius:9px;background:#fff;color:#42354f}input:focus-visible{outline:2px solid #baa5ed;outline-offset:2px}button{border:0;border-radius:9px;padding:12px;background:#8761d4;color:#fff;font:600 14px/1.5 system-ui;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.error{margin:0;color:#a13c63;font-size:13px}.error:empty{display:none}.register{margin:22px 0 0;font-size:12px}a{color:#7950b9;text-underline-offset:3px}@media(max-width:480px){.panel{padding:26px}}`;
