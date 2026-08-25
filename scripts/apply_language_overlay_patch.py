from pathlib import Path
import re

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

english_pattern = re.compile(r"  async function handleEnglishLanguageChoice\(\) \{.*?\n  async function inspectPaywallState\(\) \{", re.S)
english_replacement = r'''  async function handleEnglishLanguageChoice() {
    const result = await page.evaluate(() => {
      const languageNames = [
        'english', 'ukrainian', 'українська', 'український', 'spanish', 'español', 'french', 'français',
        'german', 'deutsch', 'italian', 'italiano', 'portuguese', 'português', 'turkish', 'türkçe',
        'polish', 'polski', 'russian', 'русский', 'arabic', 'العربية', 'japanese', '日本語',
        'korean', '한국어', 'chinese', '中文', 'dutch', 'nederlands', 'swedish', 'svenska',
        'norwegian', 'norsk', 'danish', 'dansk', 'finnish', 'suomi', 'czech', 'čeština',
        'romanian', 'română', 'hungarian', 'magyar', 'greek', 'ελληνικά'
      ];
      const normalize = value => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      };
      const reachable = el => {
        if (!visible(el)) return false;
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      };
      const languageForText = text => languageNames.find(name =>
        text === name || text.startsWith(name + ' ') || text.startsWith(name + '|') ||
        text.startsWith(name + '/') || text.startsWith(name + '(')
      ) || null;
      const cardForLabel = (labelEl, root) => {
        let el = labelEl;
        let depth = 0;
        let fallback = null;
        while (el && el !== document.body && depth < 7) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const substantial = rect.width >= 55 && rect.height >= 28 && rect.width <= window.innerWidth * 0.98;
          const explicit = tag === 'button' || tag === 'a' || tag === 'label' || tag === 'li' ||
            role === 'button' || role === 'radio' || role === 'option' || role === 'menuitem' ||
            el.hasAttribute('onclick') || el.tabIndex >= 0 || style.cursor === 'pointer';
          const bordered = parseFloat(style.borderTopWidth || '0') > 0 || parseFloat(style.borderRightWidth || '0') > 0 ||
            parseFloat(style.borderBottomWidth || '0') > 0 || parseFloat(style.borderLeftWidth || '0') > 0;
          if (substantial && explicit && reachable(el)) return el;
          if (substantial && bordered && reachable(el) && !fallback) fallback = el;
          if (el === root) break;
          el = el.parentElement;
          depth++;
        }
        if (reachable(labelEl)) return labelEl;
        return fallback;
      };

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const roots = dialogs.length ? dialogs : [document.body];
      const candidates = [];
      for (const root of roots) {
        const all = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const el of all) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
          if (!text || text.length > 100) continue;
          const language = languageForText(text);
          if (!language) continue;
          const card = cardForLabel(el, root);
          if (!card || !reachable(card)) continue;
          const rect = card.getBoundingClientRect();
          candidates.push({ language, text, card, area: rect.width * rect.height, inDialog: dialogs.includes(root) });
        }
      }

      const unique = [];
      const seen = new Set();
      for (const item of candidates) {
        if (seen.has(item.card)) continue;
        seen.add(item.card);
        unique.push(item);
      }
      const distinctLanguages = new Set(unique.map(x => x.language));
      const english = unique.filter(x => x.language === 'english').sort((a, b) =>
        Number(b.inDialog) - Number(a.inDialog) || a.area - b.area
      );
      if (distinctLanguages.size < 2 || !english.length) return null;
      const chosen = english[0];
      const id = `language-choice-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      chosen.card.setAttribute('data-language-choice-id', id);
      return { id, text: chosen.text, languages: Array.from(distinctLanguages).slice(0, 12), inDialog: chosen.inDialog };
    });

    if (!result) return false;
    console.log('Language-choice page detected. Preferring English. Languages found:', result.languages);
    if (result.inDialog) console.log('English option is inside the active modal/dialog.');
    const beforeState = await inspectPage();
    const beforeSignature = pageSignature(beforeState);
    const target = page.locator(`[data-language-choice-id="${result.id}"]`);
    const clicked = await safeCrawlerClick(target, 'English language option');
    if (!clicked) {
      console.log('English option was detected but is not safely reachable. Will not interact with controls behind the overlay.');
      return false;
    }
    await page.waitForTimeout(700);
    let afterState = await inspectPage();
    if (pageSignature(afterState) !== beforeSignature) {
      console.log('English language selected.');
      if (afterState.cta) {
        const beforeCTA = pageSignature(afterState);
        const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
        if (ctaClicked) await waitForAdvancement(beforeCTA, 7000);
      }
      return true;
    }
    afterState = await inspectPage();
    if (afterState.cta) {
      const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterState.cta.id}"]`), afterState.cta.text || 'language-choice CTA');
      return ctaClicked;
    }
    return true;
  }

  async function inspectPaywallState() {'''

s, n = english_pattern.subn(lambda m: english_replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one English language handler replacement, got {n}')

custom_pattern = re.compile(r"  async function handleCustomNativeLanguage\(state\) \{.*?\n  async function handleAnswerGroup\(state, screenNumber = null\) \{", re.S)
custom_replacement = r'''  async function handleCustomNativeLanguage(state) {
    if (!isNativeLanguageQuestion(state.pageText)) return false;
    const textInputs = page.locator('input:not([type]), input[type="text"], input[type="search"]');
    const inputCount = await textInputs.count();
    for (let i = 0; i < inputCount; i++) {
      const input = textInputs.nth(i);
      if (!(await input.isVisible().catch(() => false)) || !(await input.isEnabled().catch(() => false))) continue;
      const inputReachable = await input.evaluate(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
        const top = document.elementFromPoint(x, y);
        return !!top && (top === el || el.contains(top) || top.contains(el));
      }).catch(() => false);
      if (!inputReachable) {
        console.log('Ignoring native-language search input because it is covered by an active overlay.');
        continue;
      }

      console.log('Native-language text input detected.');
      for (const preferredLanguage of ['English', 'Spanish']) {
        const focused = await safeCrawlerClick(input, 'native-language search input');
        if (!focused) continue;
        try {
          await input.fill('');
          await input.fill(preferredLanguage);
        } catch {
          continue;
        }
        await page.waitForTimeout(500);

        const option = await page.evaluate((wantedLanguage) => {
          const wanted = wantedLanguage.toLowerCase();
          const visible = el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
              rect.top < window.innerHeight && rect.left < window.innerWidth &&
              style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
          };
          const reachable = el => {
            if (!visible(el)) return false;
            const rect = el.getBoundingClientRect();
            const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
            const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
            const top = document.elementFromPoint(x, y);
            return !!top && (top === el || el.contains(top) || top.contains(el));
          };
          const all = Array.from(document.querySelectorAll('body *'));
          const matches = [];
          for (const el of all) {
            if (!visible(el)) continue;
            const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
            if (text.toLowerCase() !== wanted) continue;
            const clickable = el.closest('button, [role="option"], [role="menuitem"], [role="button"], a, li, [tabindex]') || el;
            if (!reachable(clickable)) continue;
            const rect = clickable.getBoundingClientRect();
            const dialog = clickable.closest('[role="dialog"], [aria-modal="true"]');
            matches.push({ el: clickable, area: rect.width * rect.height, inDialog: !!dialog });
          }
          if (!matches.length) return null;
          matches.sort((a, b) => Number(b.inDialog) - Number(a.inDialog) || a.area - b.area);
          const chosen = matches[0];
          const id = `native-language-option-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
          chosen.el.setAttribute('data-native-language-option-id', id);
          return { id };
        }, preferredLanguage);

        if (!option) continue;
        const clicked = await safeCrawlerClick(
          page.locator(`[data-native-language-option-id="${option.id}"]`),
          `native-language option ${preferredLanguage}`
        );
        if (!clicked) continue;
        console.log(`Selected preferred native language: ${preferredLanguage}`);
        await page.waitForTimeout(500);
        const afterSelection = await inspectPage();
        if (afterSelection.cta) {
          const beforeCTA = pageSignature(afterSelection);
          const ctaClicked = await safeCrawlerClick(page.locator(`[data-auto-id="${afterSelection.cta.id}"]`), afterSelection.cta.text || 'answer-group CTA');
          if (ctaClicked && await waitForAdvancement(beforeCTA, 10000)) return true;
          return false;
        }
        return true;
      }
    }
    return false;
  }

  async function handleAnswerGroup(state, screenNumber = null) {'''

s, n = custom_pattern.subn(lambda m: custom_replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one custom native language handler replacement, got {n}')

p.write_text(s)
