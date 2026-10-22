// Consent page for connecting a local QuizForge app (docs/HUB_CONNECT_AI.md 3.2).
// A script navigation is used because CSP form-action would block a form redirect
// to the loopback address or the quizforge:// scheme.
const panel = document.querySelector('[data-request]');
const error = panel?.querySelector('.form-error');
for (const button of panel?.querySelectorAll('[data-decision]') ?? []) {
  button.addEventListener('click', async () => {
    for (const other of panel.querySelectorAll('[data-decision]')) other.disabled = true;
    error.textContent = '';
    try {
      const response = await fetch('/api/connect/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: panel.dataset.request, decision: button.dataset.decision }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || (typeof result.error === 'string' ? result.error : '操作失败，请回到 QuizForge 重新点击“登录”'));
      panel.querySelector('.connect-actions').hidden = true;
      error.textContent = button.dataset.decision === 'allow' ? '已允许，正在返回 QuizForge… 如果没有自动打开，请回到 QuizForge 查看。' : '已拒绝，可以关闭此页面。';
      error.classList.add('connect-done');
      location.assign(result.redirect);
    } catch (cause) {
      error.textContent = cause.message;
      for (const other of panel.querySelectorAll('[data-decision]')) other.disabled = false;
    }
  });
}
