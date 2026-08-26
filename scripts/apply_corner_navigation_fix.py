from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

# 1) Replace native Back restore block using stable comment boundaries.
start_marker = "    // Prefer the funnel's own visible Back control. Many onboarding SPAs keep every\n"
end_marker = "    // Browser history remains a secondary fallback for funnels that create a real\n"
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('restore back block markers not found')

new_back = r'''    // Prefer the funnel's own visible Back control. Many onboarding SPAs keep every
    // step on one URL and manage state internally, so browser history is not a
    // reliable way to return from a transition screen to its source question.
    // Retry the funnel-native control a few times because some funnels insert more
    // than one informational screen between an answer and its source question.
    try {
      for (let nativeBackAttempt = 1; nativeBackAttempt <= 3; nativeBackAttempt++) {
        const beforeBackState = await inspectPageNavigationSafe('native back pre-check').catch(() => null);
        const beforeBackSignature = beforeBackState ? pageSignature(beforeBackState) : '';

        const backCandidate = await evaluateNavigationSafe(() => {
          const selectors = 'button, [role="button"], a, [onclick], [tabindex]';
          const elements = Array.from(document.querySelectorAll(selectors));
          const visible = el => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
              r.top < window.innerHeight && r.left < window.innerWidth &&
              st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0 &&
              st.pointerEvents !== 'none';
          };
          const candidates = [];

          for (const el of elements) {
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            const aria = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();
            const rel = (el.getAttribute('rel') || '').trim();
            const combined = `${text} ${aria} ${title} ${rel}`.toLowerCase();
            const semanticBack = /(^|\s)(back|go back|previous|prev|geri|zuruck|zurück|retour|atras|atrás)(\s|$)/i.test(combined);
            const topLeftIcon = r.left <= Math.max(105, window.innerWidth * 0.24) &&
              r.top <= Math.max(140, window.innerHeight * 0.18) &&
              r.width <= 110 && r.height <= 110 &&
              !!el.querySelector('svg, img');
            if (!semanticBack && !topLeftIcon) continue;

            const cx = Math.max(0, Math.min(window.innerWidth - 1, r.left + r.width / 2));
            const cy = Math.max(0, Math.min(window.innerHeight - 1, r.top + r.height / 2));
            const top = document.elementFromPoint(cx, cy);
            const reachable = !!top && (top === el || el.contains(top) || top.contains(el));
            if (!reachable) continue;

            let id = el.getAttribute('data-auto-id');
            if (!id) {
              id = `crawler-back-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
              el.setAttribute('data-auto-id', id);
            }
            candidates.push({ id, semanticBack, topLeftIcon, top: r.top, left: r.left });
          }

          candidates.sort((a, b) => {
            if (a.semanticBack !== b.semanticBack) return a.semanticBack ? -1 : 1;
            if (a.topLeftIcon !== b.topLeftIcon) return a.topLeftIcon ? -1 : 1;
            if (a.top !== b.top) return a.top - b.top;
            return a.left - b.left;
          });
          return candidates[0] || null;
        });

        if (!backCandidate?.id) break;
        console.log(`Restoring branch question with the funnel's own Back control (attempt ${nativeBackAttempt}/3).`);
        const clicked = await safeCrawlerClick(
          page.locator(`[data-auto-id="${backCandidate.id}"]`),
          'funnel Back control'
        );
        if (!clicked) break;

        await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(450);
        const matched = await inspectAndMatch(500);
        if (matched) return matched;

        const afterBackState = await inspectPageNavigationSafe('native back post-check').catch(() => null);
        if (!afterBackState || (beforeBackSignature && pageSignature(afterBackState) === beforeBackSignature)) {
          console.log('Native Back control did not change the page; stopping native back retries.');
          break;
        }
      }
    } catch {}

'''
s = s[:start] + new_back + s[end:]

# 2) Extend optional-input escape discovery with icon-only upper-right controls.
old = r'''        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
        if (!escapePattern.test(text)) continue;
        candidates.push({ el, text, area: rect.width * rect.height, top: rect.top, right: window.innerWidth - rect.right });
'''
new = r'''        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
        const explicitEscape = escapePattern.test(text);
        const topRightIconEscape = !text &&
          rect.top <= Math.max(140, window.innerHeight * 0.18) &&
          (window.innerWidth - rect.right) <= Math.max(105, window.innerWidth * 0.24) &&
          rect.width <= 110 && rect.height <= 110 &&
          !!el.querySelector('svg, img');
        if (!explicitEscape && !topRightIconEscape) continue;

        const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(cx, cy);
        const reachable = !!top && (top === el || el.contains(top) || top.contains(el));
        if (!reachable) continue;

        candidates.push({
          el,
          text: text || '[top-right icon escape]',
          explicitEscape,
          topRightIconEscape,
          area: rect.width * rect.height,
          top: rect.top,
          right: window.innerWidth - rect.right
        });
'''
if old not in s:
    raise SystemExit('skip candidate block not found')
s = s.replace(old, new, 1)

old_sort = r'''      candidates.sort((a, b) => {
        const aCorner = (a.top < window.innerHeight * 0.25 ? 1 : 0) + (a.right < window.innerWidth * 0.25 ? 1 : 0);
        const bCorner = (b.top < window.innerHeight * 0.25 ? 1 : 0) + (b.right < window.innerWidth * 0.25 ? 1 : 0);
        return bCorner - aCorner || a.area - b.area;
      });
'''
new_sort = r'''      candidates.sort((a, b) => {
        if (a.explicitEscape !== b.explicitEscape) return a.explicitEscape ? -1 : 1;
        const aCorner = (a.top < window.innerHeight * 0.25 ? 1 : 0) + (a.right < window.innerWidth * 0.25 ? 1 : 0);
        const bCorner = (b.top < window.innerHeight * 0.25 ? 1 : 0) + (b.right < window.innerWidth * 0.25 ? 1 : 0);
        return bCorner - aCorner || a.area - b.area;
      });
'''
if old_sort not in s:
    raise SystemExit('skip sort block not found')
s = s.replace(old_sort, new_sort, 1)

p.write_text(s)
print('corner navigation patch applied')
