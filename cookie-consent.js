const rejectionPattern = /^(?:reject(?: all| all cookies| cookies)?|decline(?: all| cookies)?|deny(?: all)?|refuse(?: all)?|no thanks|only necessary|necessary cookies only|use necessary cookies only|continue without accepting|tümünü reddet|hepsini reddet|reddet|yalnızca gerekli|sadece gerekli|tout refuser|refuser|alle ablehnen|ablehnen|rechazar todo|rechazar|recusar tudo|recusar|rifiuta tutto|rifiuta)$/i;
const cookieIdentityPattern = /cookie|kurabiye|onetrust|cookiebot|(?:^|[\s_-])cky(?:[\s_-]|$)/i;
const cookieTextPattern = /\bcookies?\b|\bçerez(?:ler|leri)?\b|\bkurabiye\b/i;

function isCookieRejectionText(text) {
  return rejectionPattern.test(String(text || '').replace(/\s+/g, ' ').trim());
}

function isCookieAcceptanceText(text) {
  return /^(?:accept(?: all| all cookies| cookies)?|allow(?: all| cookies)?|agree|i agree|consent|tümünü kabul et|kabul et|tout accepter|accepter|alle akzeptieren|akzeptieren|aceptar todo|aceptar|aceitar tudo|aceitar|accetta tutto|accetta)$/i.test(String(text || '').replace(/\s+/g, ' ').trim());
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
      label: parent.getAttribute('aria-label') || '', text: parent.innerText || parent.getAttribute('aria-label') || parent.getAttribute('value') || '' });
  }
  return { visible, ancestors };
}

async function rejectCookieOverlays(page, { log = console.log, settleMs = 500, waitForBannerMs = 0 } = {}) {
  // CMP scripts may mount the banner after DOMContentLoaded. Only the startup
  // check opts into a bounded wait; normal per-step checks remain immediate.
  const deadline = Date.now() + Math.max(0, waitForBannerMs);
  let rejected = false;
  do {
    let foundCandidate = false;
    for (const frame of page.frames()) {
      const actions = frame.locator('button, [role="button"], input[type="button"], input[type="submit"], a');
      const count = await actions.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const action = actions.nth(i);
        if (!(await action.isVisible().catch(() => false)) || !(await action.isEnabled().catch(() => false))) continue;
        const label = ((await action.innerText().catch(() => '')) ||
          (await action.getAttribute('aria-label').catch(() => '')) ||
          (await action.getAttribute('value').catch(() => '')) || '').trim();
        if (!isCookieRejectionText(label)) continue;
        const context = await action.evaluate(readCookieActionState).catch(() => null);
        if (!context?.visible || !hasCookieContext(context.ancestors)) continue;
        foundCandidate = true;
        log('Cookie banner detected. Rejecting with:', label);
        try {
          await action.click({ timeout: 5000 });
          await page.waitForTimeout(settleMs);
          let dismissed = false;
          for (let poll = 0; poll < 12; poll++) {
            const state = await action.evaluate(readCookieActionState).catch(() => null);
            if (!state?.visible) { dismissed = true; break; }
            await page.waitForTimeout(250);
          }
          if (!dismissed) {
            log('Cookie rejection click did not dismiss the banner:', label);
            continue;
          }
          log('Cookie banner rejected and dismissed.');
          rejected = true;
          break;
        } catch (error) {
          log('Cookie rejection failed:', label, String(error?.message || error).split('\n')[0]);
        }
      }
      if (rejected) break;
    }
    if (rejected || foundCandidate || Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(350, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return rejected;
}

module.exports = { rejectCookieOverlays, isCookieRejectionText, isCookieAcceptanceText, hasCookieContext, readCookieActionState };
