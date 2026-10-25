const bindings = new WeakMap();
export function bindActivity({ document, practice = false, endpoint = '/api/activity', account = 'current' }) {
  const previous = bindings.get(document); if (previous?.account === account) return;
  previous?.cleanup(); if (!account) { bindings.delete(document); return; }
  let visitDay = '', lastPractice = 0;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const send = kind => {
    if (document.visibilityState === 'hidden') return;
    fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }), keepalive: true }).catch(() => {});
  };
  const visible = () => { if (document.visibilityState !== 'hidden' && visitDay !== today()) { visitDay = today(); send('visit'); } };
  visible(); document.addEventListener('visibilitychange', visible);
  const interval = setInterval(() => send('heartbeat'), 60000);
  const onPractice = event => {
    if (!event.isTrusted || !event.target.closest('#next,#previous,#outline-list button,#exam-start,#exam-submit') || Date.now() - lastPractice < 60000) return;
    lastPractice = Date.now(); send('practice');
  };
  if (practice) document.addEventListener('click', onPractice);
  const cleanup = () => { clearInterval(interval); document.removeEventListener('visibilitychange', visible); document.removeEventListener('click', onPractice); };
  bindings.set(document, { account, cleanup }); window.addEventListener('pagehide', event => { if (!event.persisted) cleanup(); }, { once: true });
}
