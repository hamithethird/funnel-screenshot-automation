const { chromium } = require('playwright');
function isNativeLanguageQuestion(text) {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const patterns = [
    'native language',
    'first language',
    'mother tongue',
    'mother language',
    'language do you speak',
    'language you speak',
    'your main language',
    'primary language'
  ];

  return patterns.some(pattern =>
    normalized.includes(pattern)
  );
}
function choosePreferredNativeLanguage(options) {
  const normalized = options.map((option, index) => ({
    ...option,
    originalIndex: index,
    normalizedText: (option.text || '')
      .trim()
      .toLowerCase()
  }));

  const englishNames = [
    'english',
    'ingilizce',
    'inglés',
    'ingles',
    'anglais',
    'englisch',
    'inglese'
  ];

  const spanishNames = [
    'spanish',
    'español',
    'espanol',
    'ispanyolca',
    'espagnol',
    'spanisch',
    'spagnolo'
  ];

  const english = normalized.find(option =>
    englishNames.some(name =>
      option.normalizedText === name ||
      option.normalizedText.includes(name)
    )
  );

  if (english) {
    return {
      option: english,
      reason: 'Preferred native language: English'
    };
  }

  const spanish = normalized.find(option =>
    spanishNames.some(name =>
      option.normalizedText === name ||
      option.normalizedText.includes(name)
    )
  );

  if (spanish) {
    return {
      option: spanish,
      reason: 'English unavailable; fallback native language: Spanish'
    };
  }

  return null;
}
(async () => {
  const url = process.argv[2];

  if (!url) {
    console.error('Please provide a URL.');
    process.exit(1);
  }

  const browser = await chromium.launch();

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }
  });

  await page.goto(url, {
    waitUntil: 'networkidle'
  });

function generateRandomAsciiString(length = 16) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return result;
}

const RUN_EMAIL = `${generateRandomAsciiString(16)}@gmail.com`;

async function dismissBlockingConsentOverlay() {
  const overlaySelectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.cky-modal',
    '.cky-modal-open',
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="consent"]',
    '[id*="consent"]'
  ];

  const affirmativePatterns = [
    /^accept all$/i,
    /^accept$/i,
    /^allow all$/i,
    /^allow$/i,
    /^agree$/i,
    /^i agree$/i,
    /^consent$/i,
    /^ok$/i,
    /^okay$/i,
    /^got it$/i,
    /^tümünü kabul et$/i,
    /^kabul et$/i,
    /^hepsini kabul et$/i,
    /^izin ver$/i,
    /^aceptar todo$/i,
    /^aceptar$/i,
    /^aceitar tudo$/i,
    /^aceitar$/i,
    /^tout accepter$/i,
    /^accepter$/i,
    /^alle akzeptieren$/i,
    /^akzeptieren$/i,
    /^accetta tutto$/i,
    /^accetta$/i
  ];

  const overlays = page.locator(overlaySelectors.join(','));
  const overlayCount = await overlays.count();

  for (let i = 0; i < overlayCount; i++) {
    const overlay = overlays.nth(i);

    if (!(await overlay.isVisible().catch(() => false))) {
      continue;
    }

    const actions = overlay.locator(
      'button, [role="button"], input[type="button"], ' +
      'input[type="submit"], a'
    );

    const actionCount = await actions.count();

    for (let j = 0; j < actionCount; j++) {
      const action = actions.nth(j);

      if (!(await action.isVisible().catch(() => false))) {
        continue;
      }

      const text = (
        (await action.innerText().catch(() => '')) ||
        (await action.getAttribute('aria-label')) ||
        (await action.getAttribute('value')) ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');

      if (!affirmativePatterns.some(pattern => pattern.test(text))) {
        continue;
      }

      console.log('Blocking consent modal detected. Dismissing with:', text);

      try {
        await action.click({ timeout: 5000 });
      } catch {
        continue;
      }

      await page.waitForTimeout(500);

      if (!(await overlay.isVisible().catch(() => false))) {
        console.log('Blocking consent modal dismissed.');
        return true;
      }
    }
  }

  return false;
}

async function safeCrawlerClick(locator, description = 'target') {
  await dismissBlockingConsentOverlay();

  try {
    await locator.click({ timeout: 7000 });
    return true;
  } catch (error) {
    const message = String(error?.message || error);

    if (!/intercepts pointer events|another element/i.test(message)) {
      throw error;
    }

    console.log('Click blocked while targeting:', description);

    const dismissed = await dismissBlockingConsentOverlay();

    if (!dismissed) {
      throw error;
    }

    console.log('Retrying original click after modal dismissal:', description);
    await locator.click({ timeout: 7000 });
    return true;
  }
}

await dismissBlockingConsentOverlay();

async function inspectPage() {
  return await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const all = Array.from(
      document.querySelectorAll('*')
    );

    const controls = all
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');

        const inputType =
          tag === 'input'
            ? (el.getAttribute('type') || 'text').toLowerCase()
            : null;

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < vh &&
          rect.left < vw &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0;

        const disabled =
          el.disabled === true ||
          el.getAttribute('aria-disabled') === 'true' ||
          style.pointerEvents === 'none';

        const editableField =
          tag === 'textarea' ||
          (
            tag === 'input' &&
            [
              'text',
              'email',
              'search',
              'tel',
              'url',
              'password',
              'number'
            ].includes(inputType)
          );

        const answerControl =
          role === 'radio' ||
          role === 'checkbox' ||
          (
            tag === 'input' &&
            ['radio', 'checkbox'].includes(inputType)
          );

        const navigationControl =
          tag === 'button' ||
          tag === 'a' ||
          role === 'button' ||
          (
            tag === 'input' &&
            ['button', 'submit'].includes(inputType)
          );

        const genericClickable =
          !editableField &&
          (
            tag === 'label' ||
            el.hasAttribute('onclick') ||
            el.tabIndex >= 0 ||
            style.cursor === 'pointer'
          );

        const interactive =
          answerControl ||
          navigationControl ||
          genericClickable;

        if (
          !visible ||
          disabled ||
          !interactive ||
          editableField
        ) {
          return null;
        }

        const id = `auto-${index}`;
        el.setAttribute('data-auto-id', id);

        const text = (
          el.innerText ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 100);

        return {
          id,
          parentId:
            el.parentElement
              ? all.indexOf(el.parentElement)
              : null,
          text,
          tag,
          role,
          inputType,
          answerControl,
          navigationControl,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left
        };
      })
      .filter(Boolean);

    const groups = new Map();

    for (const item of controls) {
      if (item.parentId === null) {
        continue;
      }

      if (!groups.has(item.parentId)) {
        groups.set(item.parentId, []);
      }

      groups.get(item.parentId).push(item);
    }

    let bestGroup = null;

    for (const items of groups.values()) {
      if (
        items.length < 2 ||
        items.length > 15
      ) {
        continue;
      }

      const avgWidth =
        items.reduce((sum, x) => sum + x.width, 0) /
        items.length;

      const avgHeight =
        items.reduce((sum, x) => sum + x.height, 0) /
        items.length;

      const similarSizes =
        items.every(item =>
          Math.abs(item.width - avgWidth) <=
            Math.max(avgWidth * 0.4, 20) &&
          Math.abs(item.height - avgHeight) <=
            Math.max(avgHeight * 0.4, 15)
        );

      if (!similarSizes) {
        continue;
      }

      if (
        avgWidth < 30 ||
        avgHeight < 25
      ) {
        continue;
      }

      const groupBottom =
        Math.max(...items.map(item => item.bottom));

      if (groupBottom < vh * 0.2) {
        continue;
      }

      let score =
        50 + Math.min(items.length * 5, 35);

      if (items.some(item => item.answerControl)) {
        score += 20;
      }

      const widthSimilarity =
        Math.max(...items.map(item => item.width)) -
        Math.min(...items.map(item => item.width));

      const heightSimilarity =
        Math.max(...items.map(item => item.height)) -
        Math.min(...items.map(item => item.height));

      if (
        widthSimilarity <= Math.max(avgWidth * 0.2, 12) &&
        heightSimilarity <= Math.max(avgHeight * 0.2, 10)
      ) {
        score += 15;
      }

      if (
        !bestGroup ||
        score > bestGroup.score
      ) {
        bestGroup = {
          score,
          items
        };
      }
    }

    const answerIds = new Set(
      bestGroup
        ? bestGroup.items.map(item => item.id)
        : []
    );

    let bestCTA = null;

    for (const item of controls) {
      if (
        item.answerControl ||
        answerIds.has(item.id)
      ) {
        continue;
      }

      let score = 0;

      const centerY = item.top + item.height / 2;
      const widthRatio = item.width / vw;

      // Primary navigation CTAs are usually near the bottom of onboarding screens.
      // This is a strong prior, but answer-group members were already excluded above.
      if (centerY > vh * 0.82) {
        score += 90;
      } else if (centerY > vh * 0.68) {
        score += 65;
      } else if (centerY > vh * 0.5) {
        score += 25;
      } else {
        score -= 15;
      }

      if (widthRatio >= 0.75) {
        score += 30;
      } else if (widthRatio >= 0.5) {
        score += 20;
      }

      if (
        item.height >= 40 &&
        item.height <= 100
      ) {
        score += 20;
      }

      if (item.navigationControl) {
        score += 20;
      }

      if (
        item.text.length > 0 &&
        item.text.length <= 50
      ) {
        score += 10;
      }

      if (
        item.inputType === 'submit' ||
        item.inputType === 'button'
      ) {
        score += 20;
      }

      if (
        item.width < 80 ||
        item.height < 25
      ) {
        score -= 50;
      }

      if (
        item.tag === 'a' &&
        (
          item.width < vw * 0.5 ||
          item.height < 36
        )
      ) {
        score -= 45;
      }

      if (
        !bestCTA ||
        score > bestCTA.score
      ) {
        bestCTA = {
          ...item,
          score
        };
      }
    }

    const pageText =
      document.body.innerText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000);

    return {
      pageText,
      cta:
        bestCTA && bestCTA.score >= 50
          ? bestCTA
          : null,
      group:
        bestGroup
          ? bestGroup.items
          : []
    };
  });
}

  function pageSignature(state) {
    return `${page.url()}\n${state.pageText}`;
  }

  async function handleCustomNativeLanguage(state) {
    if (!isNativeLanguageQuestion(state.pageText)) {
      return false;
    }

    const textInputs = page.locator(
      'input:not([type]), input[type="text"], input[type="search"]'
    );

    const inputCount = await textInputs.count();

    for (let i = 0; i < inputCount; i++) {
      const input = textInputs.nth(i);

      if (!(await input.isVisible()) || !(await input.isEnabled())) {
        continue;
      }

      console.log('Native-language text input detected.');

      for (const preferredLanguage of ['English', 'Spanish']) {
        await input.click();
        await input.fill('');
        await input.fill(preferredLanguage);
        await page.waitForTimeout(500);

        const candidateIndex = await page.evaluate(
          (wantedLanguage) => {
            const wanted = wantedLanguage.toLowerCase();
            const vh = window.innerHeight;
            const vw = window.innerWidth;

            const candidates = Array.from(
              document.querySelectorAll('body *')
            )
              .map((el, index) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);

                const text = (
                  el.innerText ||
                  el.textContent ||
                  ''
                )
                  .trim()
                  .replace(/\s+/g, ' ');

                const visible =
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.bottom > 0 &&
                  rect.right > 0 &&
                  rect.top < vh &&
                  rect.left < vw &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  Number(style.opacity) > 0;

                if (
                  !visible ||
                  text.toLowerCase() !== wanted
                ) {
                  return null;
                }

                return {
                  index,
                  area: rect.width * rect.height
                };
              })
              .filter(Boolean)
              .sort((a, b) => a.area - b.area);

            return candidates.length
              ? candidates[0].index
              : null;
          },
          preferredLanguage
        );

        if (candidateIndex === null) {
          continue;
        }

        const clicked = await page.evaluate(
          ({ wantedLanguage, candidateIndex }) => {
            const elements = Array.from(
              document.querySelectorAll('body *')
            );

            const el = elements[candidateIndex];

            if (!el) {
              return false;
            }

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            const text = (
              el.innerText ||
              el.textContent ||
              ''
            )
              .trim()
              .replace(/\s+/g, ' ');

            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity) > 0;

            if (
              !visible ||
              text.toLowerCase() !==
                wantedLanguage.toLowerCase()
            ) {
              return false;
            }

            const clickable =
              el.closest(
                'button, [role="option"], ' +
                '[role="menuitem"], [role="button"], ' +
                'a, li'
              ) || el;

            clickable.click();

            return true;
          },
          {
            wantedLanguage: preferredLanguage,
            candidateIndex
          }
        );

        if (!clicked) {
          continue;
        }

        console.log(
          `Selected preferred native language: ${preferredLanguage}`
        );

        await page.waitForTimeout(500);

        const afterSelection = await inspectPage();

        if (afterSelection.cta) {
          console.log(
            'Structural CTA available after answer selection:',
            afterSelection.cta.text || '(no text)'
          );

          const beforeCTA = pageSignature(afterSelection);

          await safeCrawlerClick(
            page.locator(
              `[data-auto-id="${afterSelection.cta.id}"]`
            ),
            afterSelection.cta.text || 'answer-group CTA'
          );

          const advancementStartedAt = Date.now();
          const advancementTimeoutMs = 10000;

          while (
            Date.now() - advancementStartedAt < advancementTimeoutMs
          ) {
            await page.waitForTimeout(500);

            const afterCTA = await inspectPage();

            if (pageSignature(afterCTA) !== beforeCTA) {
              console.log('Advanced after answer-group CTA.');
              return true;
            }
          }

          console.log(
            'No advancement detected after answer-group CTA within 10s.'
          );

          return false;
        }

        return true;
      }
    }

    return false;
  }

  async function handleAnswerGroup(state) {
    const initialSignature = pageSignature(state);

    const maxSelections = Math.min(
      state.group.length,
      5
    );

    for (let i = 0; i < maxSelections; i++) {
      state = await inspectPage();

      if (!state.group.length) {
        return true;
      }

      let option = null;

      if (isNativeLanguageQuestion(state.pageText)) {
        const preferred =
          choosePreferredNativeLanguage(state.group);

        if (preferred) {
          option = preferred.option;
          console.log(preferred.reason);
        }
      }

      if (!option) {
        option =
          state.group[
            Math.min(i, state.group.length - 1)
          ];
      }

      console.log(
        `Selecting option ${i + 1}:`,
        option.text || '[no visible text]'
      );

      await safeCrawlerClick(
        page.locator(
          `[data-auto-id="${option.id}"]`
        ),
        option.text || 'answer option'
      );

      await page.waitForTimeout(600);

      const afterSelection = await inspectPage();

      if (!afterSelection.group.length) {
        return true;
      }

      if (afterSelection.cta) {
        console.log(
          'Structural CTA available after answer selection:',
          afterSelection.cta.text || '(no text)'
        );

        const beforeCTA = pageSignature(afterSelection);

        await safeCrawlerClick(
          page.locator(
            `[data-auto-id="${afterSelection.cta.id}"]`
          ),
          afterSelection.cta.text || 'answer-group CTA'
        );

        const advancementStartedAt = Date.now();
        const advancementTimeoutMs = 10000;

        while (
          Date.now() - advancementStartedAt < advancementTimeoutMs
        ) {
          await page.waitForTimeout(500);

          const afterCTA = await inspectPage();

          if (pageSignature(afterCTA) !== beforeCTA) {
            console.log('Advanced after answer-group CTA.');
            return true;
          }
        }

        console.log(
          'No advancement detected after answer-group CTA within 10s.'
        );

        return false;
      }
    }

    return (
      pageSignature(await inspectPage()) !==
      initialSignature
    );
  }

  async function waitForVisualSettle({
    initialWaitMs = 2000,
    checkMs = 400,
    maxExtraWaitMs = 2000
  } = {}) {
    await page.waitForTimeout(initialWaitMs);

    let previousSnapshot = await page.evaluate(() => ({
      text: document.body.innerText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000),
      height: document.documentElement.scrollHeight
    }));

    const startedAt = Date.now();

    while (
      Date.now() - startedAt < maxExtraWaitMs
    ) {
      await page.waitForTimeout(checkMs);

      const currentSnapshot = await page.evaluate(() => ({
        text: document.body.innerText
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2000),
        height: document.documentElement.scrollHeight
      }));

      if (
        currentSnapshot.text === previousSnapshot.text &&
        currentSnapshot.height === previousSnapshot.height
      ) {
        return;
      }

      previousSnapshot = currentSnapshot;
    }
  }

  async function waitForActionableState({
    timeoutMs = 12000,
    pollMs = 500
  } = {}) {
    const startedAt = Date.now();

    const initialState = await inspectPage();
    const initialSignature = pageSignature(initialState);

    console.log(
      `No action available yet. Watching for up to ${timeoutMs / 1000}s...`
    );

    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(pollMs);

      const state = await inspectPage();
      const signature = pageSignature(state);

      const actionable =
        state.group.length > 0 ||
        state.cta !== null ||
        isNativeLanguageQuestion(state.pageText);

      if (actionable) {
        console.log(
          `Action became available after ${(
            (Date.now() - startedAt) / 1000
          ).toFixed(1)}s.`
        );

        return {
          state,
          changed: signature !== initialSignature
        };
      }

      if (signature !== initialSignature) {
        console.log(
          `Automatic page transition detected after ${(
            (Date.now() - startedAt) / 1000
          ).toFixed(1)}s.`
        );

        return {
          state,
          changed: true
        };
      }
    }

    console.log(
      `Nothing actionable or transitional appeared after ${timeoutMs / 1000}s.`
    );

    return null;
  }

  async function waitForAdvancement(
    beforeSignature,
    timeoutMs = 12000
  ) {
    const startedAt = Date.now();

    while (
      Date.now() - startedAt < timeoutMs
    ) {
      await page.waitForTimeout(500);

      const currentState = await inspectPage();

      if (
        pageSignature(currentState) !== beforeSignature
      ) {
        return true;
      }
    }

    return false;
  }

  async function handleRequiredAgreementCheckboxes(input) {
    const legalPattern = /\b(terms?|conditions?|privacy|policy|legal|agreement)\b/i;
    const acceptancePattern = /\b(accept|agree|consent)\b/i;
    const marketingPattern = /\b(news|newsletter|updates?|offers?|promotions?|marketing|communications?)\b/i;

    const candidates = page.locator(
      'input[type="checkbox"], [role="checkbox"]'
    );

    const count = await candidates.count();
    let legalFound = false;
    let allLegalActive = true;

    for (let i = 0; i < count; i++) {
      const checkbox = candidates.nth(i);

      if (!(await checkbox.isVisible().catch(() => false))) {
        continue;
      }

      const getInfo = async () =>
        await checkbox.evaluate(el => {
          let labelText = '';

          if (el.id) {
            const label = document.querySelector(
              `label[for="${CSS.escape(el.id)}"]`
            );
            if (label) labelText = label.innerText || label.textContent || '';
          }

          if (!labelText) {
            const parentLabel = el.closest('label');
            if (parentLabel) {
              labelText = parentLabel.innerText || parentLabel.textContent || '';
            }
          }

          if (!labelText) {
            labelText = el.getAttribute('aria-label') || '';
          }

          if (!labelText) {
            let ancestor = el.parentElement;
            let depth = 0;

            while (ancestor && depth < 5) {
              const checkboxCount = ancestor.querySelectorAll(
                'input[type="checkbox"], [role="checkbox"]'
              ).length;

              const text = (
                ancestor.innerText || ancestor.textContent || ''
              )
                .trim()
                .replace(/\s+/g, ' ');

              if (checkboxCount === 1 && text.length > 0 && text.length <= 350) {
                labelText = text;
                break;
              }

              ancestor = ancestor.parentElement;
              depth++;
            }
          }

          return {
            text: labelText.trim().replace(/\s+/g, ' ').slice(0, 350),
            checked:
              el.checked === true ||
              el.getAttribute('aria-checked') === 'true',
            required:
              el.required === true ||
              el.getAttribute('required') !== null ||
              el.getAttribute('aria-required') === 'true'
          };
        });

      let info = await getInfo();

      if (!info.text) continue;

      const isLegalAgreement =
        legalPattern.test(info.text) &&
        (acceptancePattern.test(info.text) || info.required);

      const isMarketingOnly =
        marketingPattern.test(info.text) &&
        !legalPattern.test(info.text);

      if (!isLegalAgreement || isMarketingOnly) {
        continue;
      }

      legalFound = true;

      for (let attempt = 1; attempt <= 3 && !info.checked; attempt++) {
        console.log('Required legal agreement checkbox detected:', info.text);

        try {
          const tag = await checkbox.evaluate(el => el.tagName.toLowerCase());
          const type = ((await checkbox.getAttribute('type')) || '').toLowerCase();

          if (tag === 'input' && type === 'checkbox') {
            await checkbox.check({ force: attempt > 1 });
          } else {
            await checkbox.click({ force: attempt > 1 });
          }
        } catch {
          const clickedLabel = await checkbox.evaluate(el => {
            let label = null;

            if (el.id) {
              label = document.querySelector(
                `label[for="${CSS.escape(el.id)}"]`
              );
            }

            label = label || el.closest('label');
            if (!label) return false;
            label.click();
            return true;
          });

          if (!clickedLabel) {
            await checkbox.click({ force: true }).catch(() => {});
          }
        }

        await page.waitForTimeout(450);
        info = await getInfo();
      }

      if (info.checked) {
        console.log('Required legal agreement is active:', info.text);
      } else {
        allLegalActive = false;
        console.log('Required legal agreement is still NOT active:', info.text);
      }
    }

    if (legalFound) {
      await input.evaluate(el => el.blur());
      await page.waitForTimeout(700);
    }

    return {
      found: legalFound,
      active: !legalFound || allLegalActive
    };
  }

  async function findBottomPrimaryFormAction(input) {
    const inputBox = await input.boundingBox();
    if (!inputBox) return null;

    const metrics = await page.evaluate(() => ({
      scrollY: window.scrollY,
      documentHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ),
      viewportWidth: window.innerWidth
    }));

    const candidates = page.locator(
      'button, [role="button"], input[type="submit"], input[type="button"]'
    );

    const count = await candidates.count();
    let best = null;

    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);

      if (!(await candidate.isVisible().catch(() => false))) continue;

      const box = await candidate.boundingBox();
      if (!box || box.width < 120 || box.height < 34) continue;

      const info = await candidate.evaluate(el => {
        const style = getComputedStyle(el);
        return {
          text: (
            el.innerText ||
            el.getAttribute('aria-label') ||
            el.getAttribute('value') ||
            ''
          ).trim().replace(/\s+/g, ' ').slice(0, 100),
          disabled:
            el.disabled === true ||
            el.getAttribute('aria-disabled') === 'true' ||
            style.pointerEvents === 'none',
          opacity: Number(style.opacity || 1),
          type: (el.getAttribute('type') || '').toLowerCase()
        };
      });

      if (info.disabled || info.opacity < 0.35) continue;

      const absoluteTop = box.y + metrics.scrollY;
      const inputBottom = inputBox.y + metrics.scrollY + inputBox.height;

      if (absoluteTop < inputBottom - 20) continue;

      const absoluteBottom = absoluteTop + box.height;
      const bottomRatio = metrics.documentHeight
        ? absoluteBottom / metrics.documentHeight
        : 0;
      const widthRatio = metrics.viewportWidth
        ? box.width / metrics.viewportWidth
        : 0;

      let score =
        Math.min(bottomRatio, 1) * 120 +
        Math.min(widthRatio, 1) * 45;

      if (info.type === 'submit') score += 25;
      if (info.text.length > 0 && info.text.length <= 40) score += 5;

      if (!best || score > best.score) {
        best = { locator: candidate, text: info.text, score };
      }
    }

    if (best) {
      console.log('Bottom primary form CTA candidate:', best.text || '(no text)');
    }

    return best;
  }

  async function handleGenericFormInput(state) {
    const fields = page.locator(
      'input:not([type]), ' +
      'input[type="text"], ' +
      'input[type="email"], ' +
      'textarea'
    );

    const count = await fields.count();

    for (let i = 0; i < count; i++) {
      const input = fields.nth(i);

      if (
        !(await input.isVisible()) ||
        !(await input.isEnabled()) ||
        !(await input.isEditable())
      ) {
        continue;
      }

      const info = await input.evaluate(el => {
        let labelText = '';

        if (el.id) {
          const label = document.querySelector(
            `label[for="${CSS.escape(el.id)}"]`
          );

          if (label) {
            labelText =
              label.innerText ||
              label.textContent ||
              '';
          }
        }

        if (!labelText) {
          const parentLabel = el.closest('label');

          if (parentLabel) {
            labelText =
              parentLabel.innerText ||
              parentLabel.textContent ||
              '';
          }
        }

        return {
          type:
            (el.getAttribute('type') || 'text').toLowerCase(),
          name:
            (el.getAttribute('name') || '').toLowerCase(),
          placeholder:
            (el.getAttribute('placeholder') || '').toLowerCase(),
          autocomplete:
            (el.getAttribute('autocomplete') || '').toLowerCase(),
          ariaLabel:
            (el.getAttribute('aria-label') || '').toLowerCase(),
          label:
            labelText.trim().toLowerCase()
        };
      });

      const signals = [
        info.name,
        info.placeholder,
        info.autocomplete,
        info.ariaLabel,
        info.label
      ].join(' ');

      let fieldType = null;
      let value = null;

      if (
        info.type === 'email' ||
        info.autocomplete === 'email' ||
        /\be-?mail\b/i.test(signals)
      ) {
        fieldType = 'email';
        value = RUN_EMAIL;
      } else if (
        [
          'name',
          'given-name',
          'first-name'
        ].includes(info.autocomplete) ||
        /\b(first[\s_-]*name|your[\s_-]*name|name)\b/i
          .test(signals)
      ) {
        fieldType = 'name';
        value = 'Alex';
      }

      if (!value) {
        continue;
      }

      console.log(`Detected ${fieldType} input.`);

      await input.fill(value);

      if (fieldType === 'email') {
        const actualEmailState = await input.evaluate(el => ({
          value: el.value,
          valid: el.validity ? el.validity.valid : null,
          validationMessage: el.validationMessage || ''
        }));

        console.log('EMAIL DEBUG - intended value:', value);
        console.log('EMAIL DEBUG - actual field value:', actualEmailState.value);
        console.log('EMAIL DEBUG - browser valid:', actualEmailState.valid);
        console.log(
          'EMAIL DEBUG - validation message:',
          actualEmailState.validationMessage || '(none)'
        );
      }

      // Trigger the validation/update patterns used by many React/Vue forms.
      await input.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      });

      await page.waitForTimeout(500);

      const agreementState =
        await handleRequiredAgreementCheckboxes(input);

      if (!agreementState.active) {
        console.log(
          'Required terms/privacy agreement could not be activated.'
        );
        return { recognized: true, advanced: false };
      }

      const beforeSubmitState = await inspectPage();
      const beforeSignature = pageSignature(beforeSubmitState);

      // 1. Prefer an actual submit control in the same HTML form.
      const form = input.locator('xpath=ancestor::form[1]');

      if ((await form.count()) > 0) {
        const submit = form.locator(
          'button[type="submit"], ' +
          'input[type="submit"], ' +
          'button:not([type])'
        ).first();

        if (
          (await submit.count()) > 0 &&
          (await submit.isVisible()) &&
          (await submit.isEnabled())
        ) {
          console.log(
            `Submitting ${fieldType} using form submit control.`
          );

          const termsBeforeSubmit =
            await handleRequiredAgreementCheckboxes(input);

          if (!termsBeforeSubmit.active) {
            return { recognized: true, advanced: false };
          }

          await safeCrawlerClick(submit, 'form submit control');

          if (await waitForAdvancement(beforeSignature)) {
            return { recognized: true, advanced: true };
          }
        }

        const submitted = await input.evaluate(el => {
          const formEl = el.closest('form');

          if (!formEl) {
            return false;
          }

          formEl.requestSubmit();
          return true;
        });

        if (submitted) {
          console.log(
            `Submitting ${fieldType} using native form submission.`
          );

          if (await waitForAdvancement(beforeSignature)) {
            return { recognized: true, advanced: true };
          }
        }
      }

      // 2. Some funnels use a button outside a literal <form>.
      // Only consider substantial button-like controls near/below the field.
      // Anchors are intentionally excluded, so Privacy Policy / Terms links
      // can never be used as form submission actions.
      const nearbyAction =
        await findBottomPrimaryFormAction(input);

      if (nearbyAction) {
        console.log(
          `Submitting ${fieldType} using bottom primary CTA:`,
          nearbyAction.text || '(no text)'
        );

        const termsBeforeNearbyAction =
          await handleRequiredAgreementCheckboxes(input);

        if (!termsBeforeNearbyAction.active) {
          return { recognized: true, advanced: false };
        }

        await safeCrawlerClick(
          nearbyAction.locator,
          nearbyAction.text || 'bottom primary CTA'
        );

        if (await waitForAdvancement(beforeSignature)) {
          return { recognized: true, advanced: true };
        }
      }

      // 3. Enter is the final safe fallback for a recognized field.
      const termsBeforeEnter =
        await handleRequiredAgreementCheckboxes(input);

      if (!termsBeforeEnter.active) {
        return { recognized: true, advanced: false };
      }

      console.log(`Trying Enter for ${fieldType} input.`);
      await input.press('Enter');

      if (await waitForAdvancement(beforeSignature)) {
        return { recognized: true, advanced: true };
      }

      console.log(
        `Unable to safely submit ${fieldType} field.`
      );

      // Important: a recognized form that cannot be safely submitted must
      // NOT fall through to the page-level CTA detector. That is how legal
      // links such as Privacy Policy were previously clicked by mistake.
      return { recognized: true, advanced: false };
    }

    return { recognized: false, advanced: false };
  }

  async function advanceOneScreen(state) {
    if (isNativeLanguageQuestion(state.pageText)) {
      const handledCustomLanguage =
        await handleCustomNativeLanguage(state);

      if (handledCustomLanguage) {
        return true;
      }
    }

    if (state.group.length > 0) {
      return await handleAnswerGroup(state);
    }

    const formResult =
      await handleGenericFormInput(state);

    if (formResult.recognized) {
      return formResult.advanced;
    }

    if (state.cta) {
      console.log(
        'Primary CTA detected:',
        state.cta.text || '(no text)'
      );

      const beforeSignature = pageSignature(state);

      await safeCrawlerClick(
        page.locator(
          `[data-auto-id="${state.cta.id}"]`
        ),
        state.cta.text || 'primary CTA'
      );

      await page.waitForTimeout(900);

      return (
        pageSignature(await inspectPage()) !==
        beforeSignature
      );
    }

    const delayedResult = await waitForActionableState();

    if (!delayedResult) {
      return false;
    }

    if (delayedResult.changed) {
      return true;
    }

    return await advanceOneScreen(delayedResult.state);
  }

  const MAX_SCREENS = 100;

  for (
    let screenNumber = 1;
    screenNumber <= MAX_SCREENS;
    screenNumber++
  ) {
    await waitForVisualSettle();

    await dismissBlockingConsentOverlay();

    const state = await inspectPage();

    const filename =
      `${String(screenNumber).padStart(2, '0')}.png`;

    await page.screenshot({
      path: filename,
      fullPage: true
    });

    console.log(`\nCaptured ${filename}`);

    console.log({
      url: page.url(),
      CTA: state.cta?.text || null,
      answerOptions:
        state.group.map(x => x.text)
    });

    const beforeSignature = pageSignature(state);

    const acted = await advanceOneScreen(state);

    if (!acted) {
      console.log(
        'No safe interaction pattern detected. Stopping.'
      );
      break;
    }

    const afterState = await inspectPage();
    const afterSignature = pageSignature(afterState);

    if (afterSignature === beforeSignature) {
      console.log(
        'No page advancement detected. Stopping safely.'
      );
      break;
    }

    if (screenNumber === MAX_SCREENS) {
      console.log(
        `Reached safety cap of ${MAX_SCREENS} screens.`
      );
    }
  }

  await browser.close();

  console.log('Crawler finished.');
})();
