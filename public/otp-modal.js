// Second step of login: asks for the 6-digit code that was emailed.
// PramanOtp.ask({ challenge, email }) -> Promise<{ token, user }>   (rejects if the person cancels)
(function () {
  window.PramanOtp = {
    ask(info) {
      return new Promise((resolve, reject) => {
        const w = document.createElement('div');
        w.style.cssText = 'position:fixed;inset:0;background:rgba(4,20,36,.72);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
        w.innerHTML = '<div style="background:#fff;border-radius:14px;padding:26px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(0,0,0,.4);color:#1c2733">' +
          '<h2 style="margin:0 0 6px;font-family:Georgia,serif;font-size:20px">Enter the code</h2>' +
          '<div style="font-size:13.5px;color:#5b6773;margin-bottom:14px">We sent a 6-digit code to <b></b>. It is valid for 10 minutes.</div>' +
          '<div id="po_err" role="alert" style="color:#b23a2c;font-size:12.5px;min-height:18px;margin-bottom:6px"></div>' +
          '<input id="po_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" style="width:100%;padding:12px;border:1px solid #dde1e6;border-radius:8px;font-size:20px;letter-spacing:.35em;text-align:center;box-sizing:border-box">' +
          '<button id="po_ok" style="width:100%;margin-top:12px;padding:12px;border:none;border-radius:8px;background:#c8781f;color:#fff;font-weight:600;font-size:14px;cursor:pointer">Verify and log in</button>' +
          '<div style="display:flex;justify-content:space-between;margin-top:12px;font-size:13px"><button id="po_re" style="background:none;border:none;color:#0a4a7c;font-weight:600;cursor:pointer;padding:0">Resend code</button><button id="po_x" style="background:none;border:none;color:#777;cursor:pointer;padding:0">Cancel</button></div></div>';
        w.querySelector('b').textContent = info.email || 'your email';
        document.body.appendChild(w);
        const $ = id => w.querySelector('#' + id), err = $('po_err'), code = $('po_code'), ok = $('po_ok'), re = $('po_re');
        code.focus();
        const close = () => w.remove();
        $('po_x').onclick = () => { close(); reject(new Error('cancelled')); };
        let wait = 30;
        const tick = () => { re.disabled = wait > 0; re.style.opacity = wait > 0 ? .5 : 1; re.textContent = wait > 0 ? 'Resend in ' + wait + 's' : 'Resend code'; if (wait > 0) { wait--; setTimeout(tick, 1000); } };
        tick();
        re.onclick = async () => {
          err.style.color = '#b23a2c'; err.textContent = '';
          try {
            const r = await fetch('/api/auth/login-otp/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: info.challenge }) });
            const d = await r.json();
            if (!r.ok) { err.textContent = d.error || 'Could not send the code.'; return; }
            err.style.color = '#1f7a6c'; err.textContent = 'A new code has been sent.'; wait = 30; tick();
          } catch { err.textContent = 'Could not reach the server.'; }
        };
        async function submit() {
          err.style.color = '#b23a2c'; err.textContent = '';
          if (!/^\d{6}$/.test(code.value.trim())) { err.textContent = 'Please enter the 6-digit code.'; return; }
          ok.disabled = true; ok.textContent = 'Checking…';
          try {
            const r = await fetch('/api/auth/login-otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: info.challenge, code: code.value.trim() }) });
            const d = await r.json();
            if (r.ok && d.token) { close(); resolve(d); return; }
            err.textContent = d.error || 'That code is not correct.';
          } catch { err.textContent = 'Could not reach the server.'; }
          ok.disabled = false; ok.textContent = 'Verify and log in';
        }
        ok.onclick = submit;
        code.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      });
    }
  };
})();
