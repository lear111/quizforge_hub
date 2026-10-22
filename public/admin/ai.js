// Admin pages for the AI service (docs/HUB_CONNECT_AI.md 8.1): API Key 管理 and 兑换码管理.
// Amounts arrive as integers of 0.0001 yuan; prices are yuan per million tokens.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const UNIT = 10000;
const yuan = (units, digits = 2) => '¥' + (Number(units || 0) / UNIT).toFixed(digits);
// Exact amounts: four decimals only when there are fractions of a cent.
const exact = units => yuan(units, Number(units || 0) % 100 ? 4 : 2);
const plain = units => String(Number(units || 0) / UNIT);
const toUnits = value => Math.round(Number(value) * UNIT);
const day = value => value ? new Date(value + 8 * 3600000).toISOString().slice(0, 10) : '';
const dateTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
// A date picked in a form means the end of that day in Shanghai.
const endOfDay = value => value ? Date.parse(value + 'T23:59:59+08:00') : null;
const STATES = { ok: ['正常', 'ok'], fault: ['故障', 'bad'], insufficient: ['余额不足', 'wait'], expired: ['已过期', ''], disabled: ['已停用', ''] };
const CODE_STATES = { available: '未使用', redeemed: '已兑换', expired: '已过期', disabled: '已停用' };
const toggle = (attrs, on, label) => `<label class="qa-switch"><input type="checkbox" role="switch" ${attrs} ${on ? 'checked' : ''} aria-label="${esc(label)}"><span></span></label>`;
const badge = (label, kind) => `<span class="qa-status ${kind}">${esc(label)}</span>`;

export function createAiPages({ root, main, api, toast }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'qa-dialog'; root.append(dialog);
  let keys = [], codes = [], page = null, dragged = null;
  // Redraws the current page with fresh data in one swap, without the loading placeholder,
  // so tests, switches and dialogs update in place.
  const rerender = async () => { if (!page) return; const name = page.name, html = name === 'ai-codes' ? await codesPage() : await keysPage(); if (page?.name === name) main.innerHTML = html; };

  function metric(label, value, note = '') { return `<section class="qa-metric"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</section>`; }
  const shortTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const sub = text => `<small class="qa-sub">${text}</small>`;
  function keyRow(item, index) {
    const [label, kind] = STATES[item.state] || ['未知', ''];
    const detail = item.state === 'fault' || item.state === 'insufficient' ? esc(item.reason || '') + (item.statusAt ? ' · ' + esc(shortTime(item.statusAt)) : '')
      : item.state === 'expired' ? '到期 ' + day(item.expires) : item.expires ? '到期 ' + day(item.expires) : '无期限';
    return `<tr draggable="true" data-key="${item.id}">
      <td class="qa-order"><span class="qa-grip" title="拖动调整顺序" aria-hidden="true">⠿</span><strong>${item.seq}</strong><span class="qa-move"><button type="button" class="qa-link" data-ai="up" data-id="${item.id}" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button><button type="button" class="qa-link" data-ai="down" data-id="${item.id}" ${index === keys.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button></span></td>
      <td class="qa-wrap"><strong>${esc(item.note || '未命名')}</strong>${sub(`<code>${esc(item.keyHint)}</code> · ${esc(item.host)}`)}</td>
      <td>${esc(item.model)}</td>
      <td>输入 ¥${plain(item.inputPrice)}${sub('输出 ¥' + plain(item.outputPrice))}</td>
      <td>${item.remaining === null ? '不限' : yuan(item.remaining)}${sub(`已调用 ${item.calls.toLocaleString('zh-CN')} 次`)}</td>
      <td>${toggle(`data-ai-key-enabled="${item.id}"`, item.enabled, `启用 ${item.seq} 号 Key`)}</td>
      <td class="qa-wrap">${badge(label, kind)}${sub(detail)}</td>
      <td class="qa-row-actions"><button type="button" class="qa-btn qa-small" data-ai="test" data-id="${item.id}">测试</button><button type="button" class="qa-btn qa-small" data-ai="edit" data-id="${item.id}">编辑</button></td></tr>`;
  }
  async function keysPage() {
    const value = await api('/official-ai'); keys = value.keys; page = { name: 'ai-keys', value };
    const s = value.stats;
    return `<div class="qa-page-top"><div><h1>API Key 管理</h1><p class="qa-muted">评分时从上往下依次尝试可用的 Key，出错的 Key 跳过 1 分钟后再试。单价为“元 / 百万 token”。</p></div>
      <div class="qa-actions"><span class="qa-muted">AI 服务</span>${toggle('data-ai-service', value.enabled, 'AI 服务开关')}<strong>${value.enabled ? '已开启' : '已关闭'}</strong></div></div>
      ${value.encryptionReady ? '' : '<p class="qa-error">服务器尚未配置加密主密钥，不能添加 API Key。</p>'}
      <div class="qa-metrics">${metric('总调用次数', Number(s.totalCalls).toLocaleString('zh-CN'))}${metric('今日使用金额', yuan(s.todayCost, 4))}${metric('总使用金额', yuan(s.totalCost, 4))}${metric('用户余额合计', yuan(s.userBalance))}</div>
      <section class="qa-panel"><div class="qa-panel-top"><h2>API Key 列表 <small class="qa-sub qa-inline">从上往下依次尝试，拖动 ⠿ 调整顺序</small></h2><button type="button" class="qa-btn primary" data-ai="add-key" ${keys.length >= value.maxKeys ? 'disabled' : ''}>新增 API Key</button></div>
      <div class="qa-scroll"><table class="qa-ai-table"><thead><tr><th>编号</th><th>备注 / Key</th><th>模型</th><th>单价（元 / 百万）</th><th>剩余金额</th><th>启用</th><th>状态</th><th></th></tr></thead>
      <tbody>${keys.length ? keys.map(keyRow).join('') : '<tr><td colspan="8" class="qa-empty">还没有 API Key，点“新增 API Key”添加</td></tr>'}</tbody></table></div></section>`;
  }
  function codeRow(item) {
    const usage = item.state === 'redeemed' ? badge('已兑换', '') + sub(`${esc(item.redeemedBy || '')} · ${esc(shortTime(item.redeemed))}`) : badge(CODE_STATES[item.state], { available: 'ok', expired: 'wait' }[item.state] || '');
    const code = item.full ? `<button type="button" class="qa-code-pill" data-ai="copy" data-code="${esc(item.code)}" title="点击复制"><code>${esc(item.code)}</code><span class="qa-copy" aria-hidden="true">复制</span></button>` : `<span class="qa-code-pill"><code>${esc(item.code)}</code></span>`;
    return `<tr><td><strong>${item.seq}</strong></td><td>${code}</td>
      <td class="qa-wrap">${esc(item.note || '—')} <button type="button" class="qa-link" data-ai="note" data-id="${item.id}" aria-label="编辑备注">✎</button></td>
      <td><strong>${yuan(item.amount)}</strong></td><td>${day(item.created)}${sub('到期 ' + day(item.expires))}</td><td>${usage}</td>
      <td>${item.state === 'redeemed' ? '<span class="qa-muted">—</span>' : toggle(`data-ai-code-enabled="${item.id}"`, item.enabled, `启用 ${item.seq} 号兑换码`)}</td></tr>`;
  }
  async function codesPage() {
    const value = await api('/ai-codes'); codes = value.items; page = { name: 'ai-codes', value };
    return `<div class="qa-page-top"><div><h1>兑换码管理</h1><p class="qa-muted">用户在 QuizForge 的设置 → 用户中心输入兑换码充值免费 AI 额度，每个码只能用一次。新账号余额为 0。</p></div></div>
      <div class="qa-metrics qa-metrics-2">${metric('兑换码总金额', yuan(value.stats.total))}${metric('已使用兑换码总金额', yuan(value.stats.redeemed))}</div>
      <section class="qa-panel"><div class="qa-panel-top"><h2>兑换码列表</h2><button type="button" class="qa-btn primary" data-ai="add-codes">新增兑换码</button></div>
      <div class="qa-scroll"><table class="qa-ai-table"><thead><tr><th>编号</th><th>兑换码</th><th>备注</th><th>金额</th><th>创建 / 到期</th><th>使用情况</th><th>启用</th></tr></thead>
      <tbody>${codes.length ? codes.map(codeRow).join('') : '<tr><td colspan="7" class="qa-empty">还没有兑换码，点“新增兑换码”生成</td></tr>'}</tbody></table></div></section>`;
  }

  // Dialogs. `submit` returns false to keep the dialog open (for example to show a result).
  function open(title, body, { submitLabel = '保存', danger = false, extra = '', submit, after = rerender }) {
    dialog.innerHTML = `<form method="dialog" class="qa-dialog-form"><h2>${esc(title)}</h2>${body}<p class="qa-error" role="alert"></p>
      <div class="qa-dialog-actions">${extra}<button type="button" class="qa-btn" data-dialog="cancel">取消</button><button type="submit" class="qa-btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button></div></form>`;
    const form = dialog.querySelector('form'), error = form.querySelector('[role=alert]'), button = form.querySelector('[type=submit]');
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      error.textContent = ''; button.disabled = true; const label = button.textContent; button.textContent = '正在处理…';
      try { if (await submit(new FormData(form), form) !== false) { dialog.close(); await after(); } }
      catch (cause) { error.textContent = cause.message; }
      finally { button.disabled = false; button.textContent = label; }
    });
    form.querySelector('[data-dialog=cancel]').addEventListener('click', () => dialog.close());
    if (!dialog.open) dialog.showModal(); form.querySelector('input:not([type=hidden])')?.focus();
    return form;
  }
  const field = (label, input, wide = false) => `<label class="${wide ? 'qa-wide' : ''}">${label}${input}</label>`;
  function addKey() {
    const d = page.value.defaults;
    open('新增 API Key', `<div class="qa-fields">
      ${field('备注', '<input name="note" maxlength="60" placeholder="阿里云主账号">', true)}
      ${field('服务地址（OpenAI 兼容，HTTPS）', `<input name="baseUrl" type="url" required maxlength="300" value="${esc(d.baseUrl)}">`, true)}
      ${field('调用模型', `<input name="model" required maxlength="64" value="${esc(d.model)}">`)}
      ${field('API Key', '<input name="apiKey" type="password" required autocomplete="off" spellcheck="false" maxlength="200">')}
      ${field('输入单价（元 / 百万 token）', `<input name="inputPrice" type="number" required min="0" max="1000" step="0.0001" value="${plain(d.inputPrice)}">`)}
      ${field('输出单价（元 / 百万 token）', `<input name="outputPrice" type="number" required min="0" max="1000" step="0.0001" value="${plain(d.outputPrice)}">`)}
      ${field('剩余金额（元，留空不限）', '<input name="remaining" type="number" min="0" max="1000000" step="0.01">')}
      ${field('到期时间（留空无期限）', '<input name="expires" type="date">')}
      ${field('管理员密码', '<input name="password" type="password" required autocomplete="current-password" maxlength="128">', true)}
      </div><p class="qa-muted">保存后立即发一条很短的测试请求，测试结果就是这个 Key 的初始状态。Key 保存后无法查看，服务地址和模型也不能再改。</p>`, {
      submitLabel: '添加并测试',
      async submit(data) {
        const remaining = String(data.get('remaining') || '').trim();
        const result = await api('/ai-keys', { body: { note: String(data.get('note') || ''), baseUrl: String(data.get('baseUrl')).trim(), model: String(data.get('model')).trim(), apiKey: String(data.get('apiKey')),
          inputPrice: toUnits(data.get('inputPrice')), outputPrice: toUnits(data.get('outputPrice')), remaining: remaining === '' ? null : toUnits(remaining), expires: endOfDay(data.get('expires')), password: String(data.get('password')) } });
        toast(result.test.ok ? `已添加 ${result.item.seq} 号 Key，测试通过。` : `已添加 ${result.item.seq} 号 Key，但测试未通过：${result.test.reason}。`);
      },
    });
  }
  function editKey(item) {
    const form = open(`编辑 ${item.seq} 号 API Key`, `<p class="qa-muted"><code>${esc(item.keyHint)}</code> · ${esc(item.note || '无备注')} · ${esc(item.model)} · ${esc(item.host)}</p><div class="qa-fields">
      ${field('输入单价（元 / 百万 token）', `<input name="inputPrice" type="number" required min="0" max="1000" step="0.0001" value="${plain(item.inputPrice)}">`)}
      ${field('输出单价（元 / 百万 token）', `<input name="outputPrice" type="number" required min="0" max="1000" step="0.0001" value="${plain(item.outputPrice)}">`)}
      ${field('剩余金额（元，留空不限）', `<input name="remaining" type="number" min="0" max="1000000" step="0.0001" value="${item.remaining === null ? '' : plain(item.remaining)}">`, true)}
      </div><p class="qa-muted">填写的是新的剩余金额，不在原来基础上累加。</p>`, {
      extra: '<button type="button" class="qa-btn danger qa-left" data-dialog="delete">删除</button>',
      async submit(data) {
        const remaining = String(data.get('remaining') || '').trim();
        await api('/ai-keys/' + item.id, { method: 'PUT', body: { inputPrice: toUnits(data.get('inputPrice')), outputPrice: toUnits(data.get('outputPrice')), remaining: remaining === '' ? null : toUnits(remaining) } });
        toast(`${item.seq} 号 Key 已保存。`);
      },
    });
    form.querySelector('[data-dialog=delete]').addEventListener('click', () => open(`删除 ${item.seq} 号 API Key？`, '<p>删除后无法恢复。调用记录和统计会保留。</p>', {
      submitLabel: '删除', danger: true, async submit() { await api('/ai-keys/' + item.id, { method: 'DELETE' }); toast(`${item.seq} 号 Key 已删除。`); },
    }));
  }
  function addCodes() {
    const later = day(Date.now() + 30 * 86400000);
    open('新增兑换码', `<div class="qa-fields">
      ${field('数量', '<input name="count" type="number" required min="1" max="200" value="10">')}
      ${field('每个金额（元）', '<input name="amount" type="number" required min="0.01" max="10000" step="0.01" value="5">')}
      ${field('到期时间', `<input name="expires" type="date" required value="${later}">`)}
      ${field('备注', '<input name="note" maxlength="60">')}</div>`, {
      submitLabel: '生成',
      async submit(data) {
        const { items } = await api('/ai-codes', { body: { count: Number(data.get('count')), amount: toUnits(data.get('amount')), expires: endOfDay(data.get('expires')), note: String(data.get('note') || '').trim() } });
        showCodes(items); return false;
      },
    });
  }
  function showCodes(items) {
    const text = items.map(item => item.code).join('\n');
    const form = open(`已生成 ${items.length} 个兑换码`, `<p class="qa-muted">每个 ${yuan(items[0].amount)}，到期 ${day(items[0].expires)}。以后也可以在列表里查看和复制未使用的码。</p><textarea readonly rows="${Math.min(10, items.length)}" class="qa-codes">${esc(text)}</textarea>`, {
      submitLabel: '完成', extra: '<button type="button" class="qa-btn qa-left" data-dialog="copy-all">复制全部</button>', async submit() { toast('兑换码已生成。'); },
    });
    form.querySelector('[data-dialog=cancel]').remove();
    form.querySelector('[data-dialog=copy-all]').addEventListener('click', () => copy(text, '已复制全部兑换码。'));
    dialog.addEventListener('close', () => rerender(), { once: true });
  }
  function editNote(item) {
    open(`编辑 ${item.seq} 号兑换码的备注`, field('备注', `<input name="note" maxlength="60" value="${esc(item.note)}">`, true), {
      async submit(data) { await api('/ai-codes/' + item.id, { method: 'PUT', body: { note: String(data.get('note') || '').trim() } }); toast('备注已保存。'); },
    });
  }
  async function copy(text, done) { try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('浏览器不允许复制，请手动选中复制。'); } }
  async function saveOrder(ids) { await api('/ai-keys/order', { method: 'PUT', body: { ids } }); toast('顺序已保存。'); await rerender(); }

  main.addEventListener('click', async event => {
    const button = event.target.closest('[data-ai]'); if (!button || !page) return;
    const action = button.dataset.ai, item = keys.find(entry => entry.id === button.dataset.id), code = codes.find(entry => entry.id === button.dataset.id);
    try {
      if (action === 'add-key') addKey();
      else if (action === 'edit' && item) editKey(item);
      else if (action === 'test' && item) { button.disabled = true; button.textContent = '测试中…'; const { test } = await api(`/ai-keys/${item.id}/test`, { body: {} }); toast(`${item.seq} 号 Key：${test.reason}（${(test.ms / 1000).toFixed(1)} 秒）`); await rerender(); }
      else if ((action === 'up' || action === 'down') && item) {
        const ids = keys.map(entry => entry.id), index = ids.indexOf(item.id), target = action === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= ids.length) return; [ids[index], ids[target]] = [ids[target], ids[index]]; await saveOrder(ids);
      }
      else if (action === 'add-codes') addCodes();
      else if (action === 'note' && code) editNote(code);
      else if (action === 'copy') await copy(button.dataset.code, '兑换码已复制。');
    } catch (cause) { toast(cause.message); await rerender(); }
  });
  main.addEventListener('change', async event => {
    const input = event.target; if (!page || input.type !== 'checkbox') return;
    try {
      if (input.hasAttribute('data-ai-service')) { await api('/official-ai', { method: 'PUT', body: { enabled: input.checked } }); toast(input.checked ? 'AI 服务已开启。' : 'AI 服务已关闭，用户会看到“免费 AI 暂未开放”。'); }
      else if (input.dataset.aiKeyEnabled) { await api(`/ai-keys/${input.dataset.aiKeyEnabled}/enabled`, { method: 'PUT', body: { enabled: input.checked } }); toast(input.checked ? 'Key 已启用。' : 'Key 已停用。'); }
      else if (input.dataset.aiCodeEnabled) { await api(`/ai-codes/${input.dataset.aiCodeEnabled}`, { method: 'PUT', body: { enabled: input.checked } }); toast(input.checked ? '兑换码已启用。' : '兑换码已停用。'); }
      else return;
    } catch (cause) { toast(cause.message); }
    await rerender();
  });
  // Drag a row by its handle (or anywhere on the row) to change the order; it saves on drop.
  main.addEventListener('dragstart', event => { const row = event.target.closest?.('tr[data-key]'); if (!row) return; dragged = row; row.classList.add('qa-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.dataset.key); });
  main.addEventListener('dragover', event => {
    const row = event.target.closest?.('tr[data-key]'); if (!dragged || !row || row === dragged) return; event.preventDefault();
    const box = row.getBoundingClientRect(); row.parentElement.insertBefore(dragged, event.clientY < box.top + box.height / 2 ? row : row.nextSibling);
  });
  main.addEventListener('dragend', async () => {
    if (!dragged) return; const row = dragged; dragged = null; row.classList.remove('qa-dragging');
    const ids = [...row.parentElement.querySelectorAll('tr[data-key]')].map(tr => tr.dataset.key);
    if (ids.join() !== keys.map(entry => entry.id).join()) { try { await saveOrder(ids); } catch (cause) { toast(cause.message); await rerender(); } }
  });

  // 用户管理 → 调整余额: a new balance (not an increment) and a required reason, with recent changes.
  async function adjustBalance(user, done) {
    const { balance, history } = await api(`/users/${user.id}/ai-balance`);
    const line = entry => `<li><span>${esc(entry.kind === 'grading' ? `${entry.day} 评分 ${entry.calls} 次` : `${shortTime(entry.at)} ${entry.kind === 'redeem' ? '兑换码 ' + entry.note : '管理员调整：' + entry.note}`)}</span><span>${entry.delta >= 0 ? '+' : '−'}${yuan(Math.abs(entry.delta), entry.kind === 'grading' ? 4 : 2)}</span></li>`;
    open(`调整 ${user.name} 的 AI 余额`, `<p class="qa-muted">当前余额 ${exact(balance)}</p><div class="qa-fields">
      ${field('新余额（元）', `<input name="balance" type="number" required min="0" max="1000000" step="0.0001" value="${plain(balance)}">`, true)}
      ${field('原因（记入操作日志）', '<textarea name="reason" required maxlength="200" rows="2"></textarea>', true)}</div>
      <p class="qa-muted">填写的是新的余额，不在原来基础上累加。</p>
      ${history.length ? `<h3 class="qa-history-title">最近的余额变动</h3><ul class="qa-history">${history.map(line).join('')}</ul>` : '<p class="qa-muted">还没有余额变动。</p>'}`, {
      async submit(data) { const result = await api(`/users/${user.id}/ai-balance`, { method: 'PUT', body: { balance: toUnits(data.get('balance')), reason: String(data.get('reason') || '').trim() } }); toast(`${user.name} 的 AI 余额已改为 ${exact(result.balance)}。`); },
      after: done,
    });
  }

  return { adjustBalance, render: name => name === 'ai-codes' ? codesPage() : keysPage(), leave() { page = null; if (dialog.open) dialog.close(); } };
}
