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

  // English names in common funnel languages
  const englishNames = [
    'english',
    'ingilizce',
    'inglés',
    'ingles',
    'anglais',
    'englisch',
    'inglese'
  ];

  // Spanish names in common funnel languages
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
// -----------------------------------
// HANDLE COOKIE / PRIVACY CONSENT
// -----------------------------------

const consentPatterns = [
  /accept all/i,
  /accept/i,
  /allow all/i,
  /allow/i,
  /agree/i,
  /i agree/i,
  /consent/i,

  // Turkish
  /tümünü kabul et/i,
  /kabul et/i,
  /hepsini kabul et/i,
  /izin ver/i,

  // Spanish
  /aceptar todo/i,
  /aceptar/i,

  // Portuguese
  /aceitar tudo/i,
  /aceitar/i,

  // French
  /tout accepter/i,
  /accepter/i,

  // German
  /alle akzeptieren/i,
  /akzeptieren/i,

  // Italian
  /accetta tutto/i,
  /accetta/i
];

const visibleButtons = page.locator(
  'button, [role="button"], a'
);

const buttonCount = await visibleButtons.count();

for (let i = 0; i < buttonCount; i++) {
  const button = visibleButtons.nth(i);

  if (!(await button.isVisible())) {
    continue;
  }

  const text = (
    (await button.innerText().catch(() => '')) ||
    (await button.getAttribute('aria-label')) ||
    ''
  ).trim();

  const isConsentButton =
    consentPatterns.some(pattern =>
      pattern.test(text)
    );

  if (isConsentButton) {
    console.log(
      `Privacy consent detected: "${text}"`
    );

    await button.click();

    await page.waitForTimeout(700);

    console.log(
      'Privacy consent accepted.'
    );

    break;
  }
}
  async function inspectPage() {
    return await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const all = Array.from(document.querySelectorAll('*'));

      const clickable = all
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);

          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');

          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < vh &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) > 0;

          const disabled =
            el.disabled === true ||
            el.getAttribute('aria-disabled') === 'true' ||
            style.pointerEvents === 'none';

          const interactive =
            tag === 'button' ||
            tag === 'a' ||
            tag === 'label' ||
            tag === 'input' ||
            role === 'button' ||
            role === 'radio' ||
            role === 'checkbox' ||
            el.hasAttribute('onclick') ||
            el.tabIndex >= 0 ||
            style.cursor === 'pointer';

          if (!visible || !interactive || disabled) {
            return null;
          }

          const id = `auto-${index}`;
          el.setAttribute('data-auto-id', id);

          const text = (
            el.innerText ||
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
            parentId: el.parentElement
              ? Array.from(all).indexOf(el.parentElement)
              : null,
            text,
            tag,
            role,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left
          };
        })
        .filter(Boolean);

      // ----------------------------
      // FIND PRIMARY CTA
      // ----------------------------

      let bestCTA = null;

      for (const item of clickable) {
        let score = 0;

        const centerY = item.top + item.height / 2;
        const widthRatio = item.width / vw;

        if (centerY > vh * 0.65) {
          score += 40;
        } else if (centerY > vh * 0.5) {
          score += 20;
        }

        if (widthRatio >= 0.75) {
          score += 30;
        } else if (widthRatio >= 0.5) {
          score += 20;
        }

        if (item.height >= 40 && item.height <= 90) {
          score += 20;
        }

        if (item.tag === 'button' || item.role === 'button') {
          score += 15;
        }

        if (item.text.length > 0 && item.text.length <= 40) {
          score += 10;
        }

        if (item.width < 80 || item.height < 25) {
          score -= 30;
        }

        if (!bestCTA || score > bestCTA.score) {
          bestCTA = {
            ...item,
            score
          };
        }
      }

      // ----------------------------
      // FIND GROUPED ANSWER OPTIONS
      // ----------------------------

      const groups = new Map();

      for (const item of clickable) {
        if (item.parentId === null) continue;

        if (!groups.has(item.parentId)) {
          groups.set(item.parentId, []);
        }

        groups.get(item.parentId).push(item);
      }

      let bestGroup = null;

      for (const items of groups.values()) {
        if (items.length < 2 || items.length > 12) {
          continue;
        }

        const avgWidth =
          items.reduce((sum, x) => sum + x.width, 0) /
          items.length;

        const avgHeight =
          items.reduce((sum, x) => sum + x.height, 0) /
          items.length;

        const similarSizes = items.every(item =>
          Math.abs(item.width - avgWidth) <=
            Math.max(avgWidth * 0.4, 20) &&
          Math.abs(item.height - avgHeight) <=
            Math.max(avgHeight * 0.4, 15)
        );

        if (!similarSizes) continue;

        if (avgWidth < 30 || avgHeight < 25) {
          continue;
        }

        const groupBottom =
          Math.max(...items.map(x => x.bottom));

        if (groupBottom < vh * 0.2) {
          continue;
        }

        const score =
          50 + Math.min(items.length * 5, 35);

        if (!bestGroup || score > bestGroup.score) {
          bestGroup = {
            score,
            items
          };
        }
      }

      const pageText = document.body.innerText
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 2000);return {
    pageText,
        cta:
          bestCTA && bestCTA.score >= 50
            ? bestCTA
            : null,

        group: bestGroup
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
            'Primary CTA after language selection:',
            afterSelection.cta.text || '(no text)'
          );

          await page
            .locator(
              `[data-auto-id="${afterSelection.cta.id}"]`
            )
            .click();

          await page.waitForTimeout(900);
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

      await page
        .locator(
          `[data-auto-id="${option.id}"]`
        )
        .click();

      await page.waitForTimeout(600);

      let afterSelection = await inspectPage();

      if (!afterSelection.group.length) {
        return true;
      }

      if (afterSelection.cta) {
        console.log(
          'Structural CTA available after answer selection:',
          afterSelection.cta.text || '(no text)'
        );

        const beforeCTA =
          pageSignature(afterSelection);

        await page
          .locator(
            `[data-auto-id="${afterSelection.cta.id}"]`
          )
          .click();

        await page.waitForTimeout(900);

        const afterCTA = await inspectPage();

        if (
          pageSignature(afterCTA) !== beforeCTA
        ) {
          return true;
        }
      }
    }

    return (
      pageSignature(await inspectPage()) !==
      initialSignature
    );
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

    if (state.cta) {
      console.log(
        'Primary CTA detected:',
        state.cta.text || '(no text)'
      );

      const beforeSignature =
        pageSignature(state);

      await page
        .locator(
          `[data-auto-id="${state.cta.id}"]`
        )
        .click();

      await page.waitForTimeout(900);

      return (
        pageSignature(await inspectPage()) !==
        beforeSignature
      );
    }

    return false;
  }

  const MAX_SCREENS = 30;

  for (
    let screenNumber = 1;
    screenNumber <= MAX_SCREENS;
    screenNumber++
  ) {
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

    const beforeSignature =
      pageSignature(state);

    const acted =
      await advanceOneScreen(state);

    if (!acted) {
      console.log(
        'No safe interaction pattern detected. Stopping.'
      );
      break;
    }

    const afterState = await inspectPage();

    const afterSignature =
      pageSignature(afterState);

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
