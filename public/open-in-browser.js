// Helps customers whose link opened inside WhatsApp / Facebook / Instagram's
// own browser, where camera and microphone sometimes do not work. Shows a
// box with "Open in Chrome" (Android) or "Open in Safari" steps (iPhone).
(function () {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const inApp = /WhatsApp|FBAN|FBAV|FB_IAB|Instagram|Line\/|; wv\)/i.test(ua);
  const noMedia = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function chromeIntent() {
    const u = new URL(location.href);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;
  }

  function box(reason) {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText = 'background:#FFF6E3;border:1px solid #E7C27A;color:#5A3D00;border-radius:14px;padding:14px 16px;margin:14px 0;font-size:15.5px;line-height:1.5;';
    const why = reason === 'blocked'
      ? 'कैमरा या माइक चालू नहीं हो पाया। / Camera or microphone could not start.'
      : 'यह लिंक WhatsApp के अंदर खुला है। कैमरा ठीक से चले, इसके लिए इसे ब्राउज़र में खोलें। / Open this link in your browser for the camera to work.';
    let action = '';
    if (isAndroid) {
      action = `<a href="${chromeIntent()}" style="display:block;text-align:center;background:#22307A;color:#fff;font-weight:700;padding:13px;border-radius:12px;text-decoration:none;margin-top:10px;">Chrome में खोलें / Open in Chrome</a>`;
    } else if (isIOS) {
      action = '<div style="margin-top:8px;">ऊपर या नीचे <b>⋯</b> या <b>शेयर</b> बटन दबाएँ → <b>Open in Safari</b> चुनें।<br>Tap <b>⋯</b> or the share button → <b>Open in Safari</b>.</div>';
    }
    action += `<button type="button" style="display:block;width:100%;margin-top:8px;background:#fff;border:1px solid #E7C27A;color:#5A3D00;font:600 15px inherit;padding:11px;border-radius:12px;">लिंक कॉपी करें / Copy link</button>`;
    el.innerHTML = `<div>${why}</div>${action}<div style="margin-top:8px;font-size:14px;">फिर भी न चले तो: फ़ोन की Settings → Apps → Chrome/WhatsApp → Permissions में Camera और Microphone “Allow” करें।</div>`;
    el.querySelector('button').onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); el.querySelector('button').textContent = 'कॉपी हो गया — Chrome/Safari में पेस्ट करें'; }
      catch { prompt('Copy this link:', location.href); }
    };
    return el;
  }

  let shown = null;
  function show(anchor, reason) {
    if (shown) shown.remove();
    shown = box(reason);
    (anchor && anchor.parentNode ? anchor.parentNode.insertBefore(shown, anchor) : document.body.prepend(shown));
  }

  window.PramanBrowserHelp = { inApp, noMedia, isAndroid, isIOS, show };
  // Warn early when we can already tell.
  document.addEventListener('DOMContentLoaded', () => {
    const anchor = document.querySelector('[data-browser-help]');
    if (anchor && (inApp || noMedia)) show(anchor, noMedia ? 'blocked' : 'inapp');
  });
})();
