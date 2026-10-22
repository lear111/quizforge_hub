// Keep Web's original picker, confirmation and import flow. Cloud review is
// offered inside that same dialog only when its packaged extensions need review.
export function bindCloudLibrary(document) {
  const form = document.getElementById('library-import-form'), error = document.getElementById('library-import-error');
  if (!form || !error || document.getElementById('cloud-extension-submit')) return;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'cloud-extension-submit'; button.hidden = true; button.textContent = '提交包内拓展审核';
  form.querySelector('.dialog-actions').append(button);
  let reviewNeeded = false;
  document.getElementById('library-import-file').addEventListener('change', () => { reviewNeeded = false; button.hidden = true; });
  new MutationObserver(() => {
    if (/摘要尚未获准/.test(error.textContent)) reviewNeeded = true;
    button.hidden = !reviewNeeded;
  }).observe(error, { childList: true, subtree: true, characterData: true });
  button.addEventListener('click', async () => {
    const file = document.getElementById('library-import-file').files?.[0]; if (!file || button.disabled) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/cloud/extensions/submissions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/vnd.quizforge.qbank', 'X-QuizForge-Filename': encodeURIComponent(file.name) }, body: file, signal: AbortSignal.timeout(180000) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '提交失败，请稍后重试');
      reviewNeeded = false; button.hidden = true;
      error.hidden = false; error.textContent = result.item.status === 'verified' ? '拓展已匹配白名单，可以重新导入。' : '拓展审核已提交，通过后请重新导入。私人题库未公开。';
    } catch (failure) { error.hidden = false; error.textContent = failure.message; }
    finally { button.disabled = false; }
  });
}
