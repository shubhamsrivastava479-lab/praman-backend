// Picture code for forms. Usage: const cap = PramanCaptcha.mount(element); ... cap.value() -> { captchaId, captchaAnswer }; cap.refresh()
(function () {
  if (!document.getElementById('pc-style')) {
    const st = document.createElement('style'); st.id = 'pc-style';
    st.textContent = '.pc{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pc img{height:48px;border:1px solid #dde1e6;border-radius:8px;background:#f1f5f9;display:block}' +
      '.pc button{width:auto!important;margin:0!important;padding:6px 10px!important;background:#eef3f8!important;color:#2b4a66!important;border:none;border-radius:8px;font-size:13px;cursor:pointer}' +
      '.pc input{flex:1;min-width:130px;width:auto!important;margin:0!important;text-transform:uppercase;letter-spacing:.12em}';
    document.head.appendChild(st);
  }
  window.PramanCaptcha = {
    mount(el) {
      el.innerHTML = '<div class="pc"><img alt="Picture code" width="168" height="48"><button type="button" title="New picture">↻ New</button><input maxlength="5" autocomplete="off" autocapitalize="characters" placeholder="Type the letters"></div>';
      const img = el.querySelector('img'), input = el.querySelector('input'); let id = '';
      async function refresh() {
        input.value = '';
        try { const r = await (await fetch('/api/auth/captcha', { cache: 'no-store' })).json(); id = r.id; img.src = r.image; } catch { id = ''; }
      }
      el.querySelector('button').onclick = refresh;
      refresh();
      return { refresh, value: () => ({ captchaId: id, captchaAnswer: input.value.trim() }), focus: () => input.focus() };
    }
  };
})();
