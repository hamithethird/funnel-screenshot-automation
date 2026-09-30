const rejectionPattern = /^(?:reject(?: all| all cookies| cookies)?|decline(?: all| cookies)?|deny(?: all)?|refuse(?: all)?|no thanks|only necessary|necessary cookies only|use necessary cookies only|continue without accepting|tümünü reddet|hepsini reddet|reddet|yalnızca gerekli|sadece gerekli|tout refuser|refuser|alle ablehnen|ablehnen|rechazar todo|rechazar|recusar tudo|recusar|rifiuta tutto|rifiuta)$/i;
const cookieIdentityPattern = /cookie|kurabiye|onetrust|cookiebot|(?:^|[\s_-])cky(?:[\s_-]|$)/i;
const cookieTextPattern = /\bcookies?\b|\bçerez(?:ler|leri)?\b|\bkurabiye\b/i;

function isCookieRejectionText(text) {
  return rejectionPattern.test(String(text || '').replace(/\s+/g, ' ').trim());
}

function hasCookieContext(ancestors) {
  return ancestors.some(item =>
    cookieIdentityPattern.test(`${item.id || ''} ${item.className || ''} ${item.label || ''}`) ||
    (item.text.length <= 4000 && cookieTextPattern.test(item.text))
  );
}

function readCookieActionState(el) {
  const ancestors = [];
  const rect = el.getBoundingClientRect();
  let visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  for (let parent = el; parent && !['BODY', 'HTML'].includes(parent.tagName); parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
    ancestors.push({ id: parent.id, className: String(parent.className || ''),
      label: parent.getAttribute('aria-label') || '', text: parent.innerText || '' });
  }
  return { visible, ancestors };
}

async function rejectCookieOverlays(page, { log = console.log, settleMs = 500 } = {}) {
  let rejected = false;
  // Playwright locators also reach open shadow roots; frames cover embedded CMPs.
  for (const frame of page.frames()) {
    const actions = frame.locator('button, [role="button"], input[type="button"], input[type="submit"], a');
    const count = await actions.count();
    for (let i = 0; i < count; i++) {
      const action = actions.nth(i);
      if (!(await action.isVisible().catch(() => false)) || !(await action.isEnabled().catch(() => false))) continue;
      const text = ((await action.innerText().catch(() => '')) ||
        (await action.getAttribute('aria-label')) || (await action.getAttribute('value')) || '').trim();
      if (!isCookieRejectionText(text)) continue;
      // Ignore body text and transparent/offscreen banners retained in the DOM.
      const context = await action.evaluate(readCookieActionState).catch(() => null);
      if (!context?.visible || !hasCookieContext(context.ancestors)) continue;
      log('Cookie banner detected. Rejecting with:', text);
      try {
        await action.click({ timeout: 5000 });
        await page.waitForTimeout(settleMs);
        let dismissed = false;
        for (let poll = 0; poll < 12; poll++) {
          const state = await action.evaluate(readCookieActionState).catch(() => null);
          if (!state?.visible) { dismissed = true; break; }
          await page.waitForTimeout(250);
        }
        if (!dismissed) throw new Error('banner still visible');
      } catch {
        log('Cookie rejection did not close the banner:', text);
        continue;
      }
      log('Cookie banner rejected and dismissed.');
      rejected = true;
      // The click changes the DOM. Refresh actions on the next call/frame
      // rather than reusing indexes that could now point at funnel answers.
      break;
    }
  }
  return rejected;
}

module.exports = { rejectCookieOverlays, isCookieRejectionText, hasCookieContext };
