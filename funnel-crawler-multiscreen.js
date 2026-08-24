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
            ? (
                el.getAttribute('type') ||
                'text'
              ).toLowerCase()
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

        /*
         * Critical separation:
         *
         * Editable fields are FORM INPUTS.
         * They are never navigation CTAs and never
         * answer-group candidates.
         */
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
            [
              'radio',
              'checkbox'
            ].includes(inputType)
          );

        const navigationControl =
          tag === 'button' ||
          tag === 'a' ||
          role === 'button' ||
          (
            tag === 'input' &&
            [
              'button',
              'submit'
            ].includes(inputType)
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

        el.setAttribute(
          'data-auto-id',
          id
        );

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

    // -----------------------------------
    // PRIMARY NAVIGATION CTA
    // -----------------------------------

    let bestCTA = null;

    for (const item of controls) {
      /*
       * Answer controls should not compete
       * with navigation CTAs.
       */
      if (item.answerControl) {
        continue;
      }

      let score = 0;

      const centerY =
        item.top + item.height / 2;

      const widthRatio =
        item.width / vw;

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
        score -= 30;
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

    // -----------------------------------
    // GROUPED ANSWER OPTIONS
    // -----------------------------------

    const groups = new Map();

    for (const item of controls) {
      /*
       * A large navigation button should
       * not create a fake answer group.
       */
      if (
        item.navigationControl &&
        !item.answerControl
      ) {
        continue;
      }

      if (item.parentId === null) {
        continue;
      }

      if (!groups.has(item.parentId)) {
        groups.set(
          item.parentId,
          []
        );
      }

      groups
        .get(item.parentId)
        .push(item);
    }

    /*
     * Some funnels use clickable DIV/LABEL
     * cards rather than radio elements.
     *
     * Build a second grouping pass for
     * sibling option-like controls.
     */
    for (const item of controls) {
      if (
        item.navigationControl ||
        item.answerControl ||
        item.parentId === null
      ) {
        continue;
      }

      if (!groups.has(item.parentId)) {
        groups.set(
          item.parentId,
          []
        );
      }

      const group =
        groups.get(item.parentId);

      if (
        !group.some(
          existing =>
            existing.id === item.id
        )
      ) {
        group.push(item);
      }
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
        items.reduce(
          (sum, x) =>
            sum + x.width,
          0
        ) / items.length;

      const avgHeight =
        items.reduce(
          (sum, x) =>
            sum + x.height,
          0
        ) / items.length;

      const similarSizes =
        items.every(item =>
          Math.abs(
            item.width - avgWidth
          ) <=
            Math.max(
              avgWidth * 0.4,
              20
            ) &&
          Math.abs(
            item.height - avgHeight
          ) <=
            Math.max(
              avgHeight * 0.4,
              15
            )
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
        Math.max(
          ...items.map(
            item => item.bottom
          )
        );

      if (
        groupBottom <
        vh * 0.2
      ) {
        continue;
      }

      let score =
        50 +
        Math.min(
          items.length * 5,
          35
        );

      if (
        items.some(
          item =>
            item.answerControl
        )
      ) {
        score += 20;
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

    const pageText =
      document.body.innerText
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000);

    return {
      pageText,

      cta:
        bestCTA &&
        bestCTA.score >= 50
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

  const beforeCTA =
    pageSignature(afterSelection);

  await page
    .locator(
      `[data-auto-id="${afterSelection.cta.id}"]`
    )
    .click();

  const advancementStartedAt = Date.now();
  const advancementTimeoutMs = 10000;

  while (
    Date.now() - advancementStartedAt <
    advancementTimeoutMs
  ) {
    await page.waitForTimeout(500);

    const afterCTA = await inspectPage();

    if (
      pageSignature(afterCTA) !== beforeCTA
    ) {
      console.log(
        'Advanced after answer-group CTA.'
      );

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

        const advancementStartedAt = Date.now();
const advancementTimeoutMs = 10000;

while (
  Date.now() - advancementStartedAt <
  advancementTimeoutMs
) {
  await page.waitForTimeout(500);

  const afterCTA = await inspectPage();

  if (
    pageSignature(afterCTA) !== beforeCTA
  ) {
    console.log(
      'Advanced after answer-group CTA.'
    );

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
    Date.now() - startedAt <
    timeoutMs
  ) {
    await page.waitForTimeout(500);

    const currentState =
      await inspectPage();

    if (
      pageSignature(currentState) !==
      beforeSignature
    ) {
      return true;
    }
  }

  return false;
}

async function handleGenericFormInput(state) {
  const fields = page.locator(
    'input:not([type]), ' +
    'input[type="text"], ' +
    'input[type="email"], ' +
    'textarea'
  );

  const count =
    await fields.count();

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const input =
      fields.nth(i);

    if (
      !(await input.isVisible()) ||
      !(await input.isEnabled()) ||
      !(await input.isEditable())
    ) {
      continue;
    }

    const info =
      await input.evaluate(el => {
        let labelText = '';

        if (el.id) {
          const label =
            document.querySelector(
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
          const parentLabel =
            el.closest('label');

          if (parentLabel) {
            labelText =
              parentLabel.innerText ||
              parentLabel.textContent ||
              '';
          }
        }

        return {
          type:
            (
              el.getAttribute('type') ||
              'text'
            ).toLowerCase(),

          name:
            (
              el.getAttribute('name') ||
              ''
            ).toLowerCase(),

          placeholder:
            (
              el.getAttribute(
                'placeholder'
              ) || ''
            ).toLowerCase(),

          autocomplete:
            (
              el.getAttribute(
                'autocomplete'
              ) || ''
            ).toLowerCase(),

          ariaLabel:
            (
              el.getAttribute(
                'aria-label'
              ) || ''
            ).toLowerCase(),

          label:
            labelText
              .trim()
              .toLowerCase()
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
      value = 'alex@example.com';
    } else if (
      [
        'name',
        'given-name',
        'first-name'
      ].includes(
        info.autocomplete
      ) ||
      /\b(first[\s_-]*name|your[\s_-]*name|name)\b/i
        .test(signals)
    ) {
      fieldType = 'name';
      value = 'Alex';
    }

    /*
     * Unknown text fields are deliberately
     * left alone.
     */
    if (!value) {
      continue;
    }

    console.log(
      `Detected ${fieldType} input.`
    );

    await input.fill(value);
    await page.waitForTimeout(400);

    const beforeSubmitState =
      await inspectPage();

    const beforeSignature =
      pageSignature(
        beforeSubmitState
      );

    // -----------------------------------
    // STRATEGY 1:
    // REAL SUBMIT CONTROL IN SAME FORM
    // -----------------------------------

    const form =
      input.locator(
        'xpath=ancestor::form[1]'
      );

    if (
      (await form.count()) > 0
    ) {
      const submit =
        form.locator(
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

        await submit.click();

        if (
          await waitForAdvancement(
            beforeSignature
          )
        ) {
          return true;
        }
      }

      // --------------------------------
      // STRATEGY 2:
      // NATIVE FORM SUBMISSION
      // --------------------------------

      const submitted =
        await input.evaluate(el => {
          const formEl =
            el.closest('form');

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

        if (
          await waitForAdvancement(
            beforeSignature
          )
        ) {
          return true;
        }
      }
    }

    // -----------------------------------
    // STRATEGY 3:
    // CLEAN STRUCTURAL CTA
    // -----------------------------------

    const afterFill =
      await inspectPage();

    if (afterFill.cta) {
      console.log(
        `Submitting ${fieldType} using structural CTA:`,
        afterFill.cta.text ||
          '(no text)'
      );

      await page
        .locator(
          `[data-auto-id="${afterFill.cta.id}"]`
        )
        .click();

      if (
        await waitForAdvancement(
          beforeSignature
        )
      ) {
        return true;
      }
    }

    // -----------------------------------
    // STRATEGY 4:
    // KEYBOARD SUBMISSION
    // -----------------------------------

    console.log(
      `Trying Enter for ${fieldType} input.`
    );

    await input.press('Enter');

    if (
      await waitForAdvancement(
        beforeSignature
      )
    ) {
      return true;
    }

    console.log(
      `Unable to safely submit ${fieldType} field.`
    );

    return false;
  }

  return false;
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
const handledFormInput =
  await handleGenericFormInput(state);

if (handledFormInput) {
  return true;
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

    const delayedResult =
  await waitForActionableState();

if (!delayedResult) {
  return false;
}

if (delayedResult.changed) {
  return true;
}

return await advanceOneScreen(
  delayedResult.state
);
  }

  const MAX_SCREENS = 100;

  for (
    let screenNumber = 1;
    screenNumber <= MAX_SCREENS;
    screenNumber++
  ) {
   await waitForVisualSettle();

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
