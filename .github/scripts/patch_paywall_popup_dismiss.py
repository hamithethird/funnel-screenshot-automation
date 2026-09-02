from pathlib import Path

path = Path('funnel-crawler-multiscreen.js')
source = path.read_text()

helper_marker = '  async function captureHighResolutionFullPage(filename, scaleFactor = 2) {'
helper_code = r'''  async function dismissPaywallObscuringPopup(maxAttempts = 4) {
    // Paywalls sometimes show a temporary upsell/discount modal over the actual
    // pricing page. We only dismiss overlays that expose an explicit negative or
    // close action; we never click the positive offer CTA (Claim discount, Buy,
    // Continue, etc.). This keeps the underlying paywall readable without
    // accidentally purchasing/selecting an offer.
    const findDismissTarget = async () => {
      return await page.evaluate(() => {
        const overlaySelector = [
          'dialog',
          '[role="dialog"]',
          '[aria-modal="true"]',
          '[class*="modal" i]',
          '[class*="popup" i]',
          '[class*="overlay" i]',
          '[class*="sheet" i]',
          '[class*="drawer" i]'
        ].join(', ');
        const clickableSelector = 'button, a, [role="button"], [onclick], [tabindex]';
        const negativePattern = /^(?:close|dismiss|no thanks|no, thanks|not now|maybe later|skip|decline|continue without(?: this)?|i don['’]?t want it|i do not want it|i don['’]?t want this|no,? i don['’]?t want it)$/i;
        const closeLabelPattern = /\b(close|dismiss)\b/i;

        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
            r.top < window.innerHeight && r.left < window.innerWidth &&
            st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
            st.pointerEvents !== 'none';
        };
        const reachable = el => {
          if (!visible(el)) return false;
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
          const y = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
          const top = document.elementFromPoint(x, y);
          return !!top && (top === el || el.contains(top) || top.contains(el));
        };

        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        const overlays = Array.from(document.querySelectorAll(overlaySelector))
          .filter(visible)
          .map(el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const areaRatio = (r.width * r.height) / viewportArea;
            const z = Number.parseInt(st.zIndex || '0', 10) || 0;
            const modalSemantic = el.matches('dialog, [role="dialog"], [aria-modal="true"]');
            const fixedLike = st.position === 'fixed' || st.position === 'sticky';
            return { el, r, areaRatio, z, modalSemantic, fixedLike };
          })
          // Exclude tiny badges/tooltips and ordinary inline cards. A real blocking
          // promo is normally modal-semantic or fixed/sticky and covers a meaningful
          // part of the viewport.
          .filter(item => item.areaRatio >= 0.12 && (item.modalSemantic || item.fixedLike || item.z > 10))
          .sort((a, b) => b.z - a.z || b.areaRatio - a.areaRatio);

        for (const overlay of overlays) {
          const controls = Array.from(overlay.el.querySelectorAll(clickableSelector))
            .filter(el => visible(el) && reachable(el));
          const scored = [];

          for (const control of controls) {
            const r = control.getBoundingClientRect();
            const text = (control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = (control.getAttribute('aria-label') || '').trim();
            const title = (control.getAttribute('title') || '').trim();
            const combinedLabel = `${aria} ${title}`.trim();
            let score = 0;
            let reason = '';

            if (negativePattern.test(text)) {
              score = 100;
              reason = `negative action: ${text}`;
            } else if (closeLabelPattern.test(combinedLabel)) {
              score = 95;
              reason = `close control: ${combinedLabel}`;
            } else {
              // Icon-only X/close buttons commonly live in the top-right of the
              // modal. Only accept a small control near that corner so we do not
              // mistake a large offer CTA for a dismiss action.
              const nearTopRight = r.top <= overlay.r.top + Math.max(90, overlay.r.height * 0.20) &&
                r.right >= overlay.r.right - Math.max(90, overlay.r.width * 0.22);
              const small = r.width <= 72 && r.height <= 72;
              const iconOnly = !text && !!control.querySelector('svg, img, [class*="icon" i]');
              if (nearTopRight && small && iconOnly) {
                score = 80;
                reason = 'top-right icon close control';
              }
            }

            if (!score) continue;
            const id = `crawler-paywall-dismiss-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
            control.setAttribute('data-crawler-paywall-dismiss-id', id);
            scored.push({ id, score, reason });
          }

          scored.sort((a, b) => b.score - a.score);
          if (scored.length) return { ...scored[0], overlayFound: true };
        }

        return { overlayFound: overlays.length > 0, id: null, score: 0, reason: '' };
      }).catch(() => ({ overlayFound: false, id: null, score: 0, reason: '' }));
    };

    let dismissedAny = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const target = await findDismissTarget();
      if (!target?.overlayFound) break;

      if (!target.id) {
        // Some dialogs only support Escape. Try it once, then re-check whether the
        // blocking overlay actually disappeared. If it did not, leave the UI alone
        // rather than clicking arbitrary paywall controls.
        const beforeCount = await page.locator('dialog:visible, [role="dialog"]:visible, [aria-modal="true"]:visible, [class*="modal" i]:visible, [class*="popup" i]:visible, [class*="overlay" i]:visible, [class*="sheet" i]:visible, [class*="drawer" i]:visible').count().catch(() => 0);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(600);
        const afterCount = await page.locator('dialog:visible, [role="dialog"]:visible, [aria-modal="true"]:visible, [class*="modal" i]:visible, [class*="popup" i]:visible, [class*="overlay" i]:visible, [class*="sheet" i]:visible, [class*="drawer" i]:visible').count().catch(() => beforeCount);
        if (afterCount < beforeCount) {
          console.log('Dismissed paywall-obscuring popup with Escape.');
          dismissedAny = true;
          continue;
        }
        console.log('Paywall overlay detected, but no safe dismiss/decline control was found. Leaving it untouched.');
        break;
      }

      console.log(`Paywall-obscuring popup detected. Dismissing via ${target.reason || 'safe close control'}.`);
      const clicked = await safeCrawlerClick(
        page.locator(`[data-crawler-paywall-dismiss-id="${target.id}"]`),
        target.reason || 'paywall popup dismiss control'
      );
      if (!clicked) break;
      dismissedAny = true;
      await page.waitForTimeout(700);
      await silenceMedia();
    }

    return dismissedAny;
  }

'''

if 'async function dismissPaywallObscuringPopup' not in source:
    if helper_marker not in source:
        raise SystemExit('Could not find captureHighResolutionFullPage insertion point.')
    source = source.replace(helper_marker, helper_code + helper_marker, 1)

old_block = r'''    const paywallState = await inspectPaywallState();
    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);
    await prepareFullPageCapture();
    await page.screenshot({ path: filename, fullPage: true });
    registerBaseScreenshot(screenNumber, filename);
    currentNumberedCaptureSignature = pageSignature(state);
'''

new_block = r'''    let paywallState = await inspectPaywallState();
    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, '0')}.png`);

    // If this is a paywall, clear temporary promo/discount dialogs before the
    // numbered screenshot. Otherwise both the ordinary capture and the later 2x
    // high-resolution capture would preserve the obstruction and hide pricing.
    if (paywallState.isPagePaywall) {
      const dismissedPaywallPopup = await dismissPaywallObscuringPopup();
      if (dismissedPaywallPopup) {
        await page.waitForTimeout(500);
        await waitForVisualSettle();
        await silenceMedia();
        state = await inspectPageNavigationSafe('paywall after popup dismissal');
        paywallState = await inspectPaywallState();
      }
    }

    await prepareFullPageCapture();
    await page.screenshot({ path: filename, fullPage: true });
    registerBaseScreenshot(screenNumber, filename);
    currentNumberedCaptureSignature = pageSignature(state);
'''

if old_block in source:
    source = source.replace(old_block, new_block, 1)
elif 'const dismissedPaywallPopup = await dismissPaywallObscuringPopup();' not in source:
    raise SystemExit('Could not find the main paywall screenshot block to patch safely.')

path.write_text(source)
print('Applied paywall popup dismissal patch.')
