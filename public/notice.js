const button = document.querySelector('#copy-code');
button.addEventListener('click', async () => {
  const code = document.querySelector('#extraction-code').textContent;
  const feedback = document.querySelector('#copy-feedback');
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = '已复制'; feedback.textContent = '提取码已复制，打开网盘后粘贴即可。';
  } catch {
    feedback.textContent = '未能自动复制，请手动复制上方提取码。';
  }
});
