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
  await page.screenshot({
    path: '01.png',
    fullPage: true
  });

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

  // -----------------------------------
  // FIRST INSPECTION
  // -----------------------------------

  let state = await inspectPage();

  console.log('\nInitial page state:');
  console.log({
    CTA: state.cta?.text || null,
    answerOptions: state.group.map(x => x.text)
  });

  // -----------------------------------
  // CASE 1:
  // PRIMARY CTA ALREADY AVAILABLE
  // -----------------------------------

  // -----------------------------------
// CASE 1:
// ANSWER OPTIONS ARE PRESENT
// -----------------------------------
const initialCTAId = state.cta?.id || null;
if (state.group.length > 0) {
  console.log(
    `Answer group detected with ${state.group.length} options.`
  );

  const maxSelections = Math.min(
    state.group.length,
    5
  );

  for (let i = 0; i < maxSelections; i++) {
    // Reinspect because the page may rerender
    state = await inspectPage();

    // If the answer group disappeared, the page probably advanced
    if (!state.group.length) {
      console.log(
        'Answer group disappeared after selection.'
      );
      break;
    }

    let option;

// Special rule:
// Native-language question → English first → Spanish fallback
if (isNativeLanguageQuestion(state.pageText)) {
  const preferredLanguage =
    choosePreferredNativeLanguage(state.group);

  if (preferredLanguage) {
    option = preferredLanguage.option;

    console.log(
      preferredLanguage.reason
    );
  }
}

// Normal fallback for every other question
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
      .locator(`[data-auto-id="${option.id}"]`)
      .click();

    await page.waitForTimeout(500);

    // Reinspect after the click
    state = await inspectPage();

    // If the group disappeared, we likely moved forward
    if (!state.group.length) {
      console.log(
        'Page advanced after selecting an option.'
      );
      break;
    }

    // If a CTA is now available, stop selecting
    if (
  state.cta &&
  state.cta.id !== initialCTAId
) {
  console.log(
    `New CTA appeared after ${i + 1} selection(s).`
  );
  break;
}

  // Final inspection
  state = await inspectPage();

  if (
  state.cta &&
  (
    initialCTAId === null ||
    state.cta.id !== initialCTAId
  )
) {
    console.log(
      'CTA detected after answer selection. Clicking it.'
    );

    await page
      .locator(`[data-auto-id="${state.cta.id}"]`)
      .click();

    await page.waitForTimeout(1200);
  }

// -----------------------------------
// CASE 2:
// NO ANSWER GROUP, SO USE PRIMARY CTA
// -----------------------------------

else if (state.cta) {
  console.log('Primary CTA detected.');

  await page
    .locator(`[data-auto-id="${state.cta.id}"]`)
    .click();

  await page.waitForTimeout(1200);
}

// -----------------------------------
// CASE 3:
// NOTHING SAFE FOUND
// -----------------------------------

else {
  console.log(
    'No safe interaction pattern detected.'
  );
}

    const maxSelections = Math.min(
      state.group.length,
      5
    );

    for (let i = 0; i < maxSelections; i++) {
      // Reinspect because the page may rerender
      state = await inspectPage();

      // CTA appeared: stop selecting
    

      if (!state.group.length) {
        console.log(
          'Answer group disappeared after selection.'
        );
        break;
      }

      const option =
        state.group[
          Math.min(i, state.group.length - 1)
        ];

      console.log(
        `Selecting option ${i + 1}:`,
        option.text || '[no visible text]'
      );

      await page
        .locator(`[data-auto-id="${option.id}"]`)
        .click();

      await page.waitForTimeout(500);
    }
}
    // Final inspection after selecting options
    state = await inspectPage();
}
  await page.screenshot({
    path: '02.png',
    fullPage: true
  });
// TEMPORARY TEST: inspect second screen
const secondState = await inspectPage();

console.log('\nSecond screen:');
console.log({
  nativeLanguageQuestion:
    isNativeLanguageQuestion(secondState.pageText),
  answerOptions:
    secondState.group.map(x => x.text)
});
const dropdownInfo = await page.evaluate(() => {
  return Array.from(
    document.querySelectorAll(
      'select, [role="combobox"], [aria-haspopup="listbox"]'
    )
  ).map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    text: (el.innerText || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 200)
  }));
});

console.log('Dropdowns found:', dropdownInfo);
if (
  isNativeLanguageQuestion(secondState.pageText) &&
  dropdownInfo.length === 0
) {
  const visibleElements = await page.evaluate(() => {
    const vh = window.innerHeight;

    return Array.from(document.querySelectorAll('*'))
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        const visible =
          rect.width >= 100 &&
          rect.height >= 30 &&
          rect.top >= 0 &&
          rect.top < vh &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0;

        if (!visible) return null;

        return {
          index,
          tag: el.tagName,
          text: (el.innerText || el.textContent || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 150),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          cursor: style.cursor
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top)
      .slice(0, 30);
  });

  console.log(
    'Visible screen elements:',
    visibleElements
  );
  const inputs = await page.evaluate(() => {
  return Array.from(
    document.querySelectorAll('input')
  ).map((input, index) => ({
    index,
    type: input.type,
    value: input.value,
    placeholder: input.placeholder,
    ariaLabel: input.getAttribute('aria-label'),
    autocomplete: input.autocomplete,
    disabled: input.disabled,
    readOnly: input.readOnly
  }));
});

console.log('Inputs found:', inputs);
}
if (
  isNativeLanguageQuestion(secondState.pageText) &&
  secondState.group.length > 0
) {
  const preferredLanguage =
    choosePreferredNativeLanguage(secondState.group);

  if (preferredLanguage) {
    console.log(preferredLanguage.reason);
    console.log(
      'Selecting:',
      preferredLanguage.option.text
    );

    await page
      .locator(
        `[data-auto-id="${preferredLanguage.option.id}"]`
      )
      .click();

    await page.waitForTimeout(800);

    await page.screenshot({
      path: '03.png',
      fullPage: true
    });
  }
}
  await browser.close();

  console.log('Smart step finished.');
})();