function chooseEvaluationOption(options) {
  return options.find(option => !option.disabled && option.value !== '' &&
    option.text.trim() && !/^(?:choose|select|pick)\b/i.test(option.text.trim())) || null;
}

async function findEvaluationDropdown(page) {
  return await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight)) return false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    };
    const mark = (el, kind) => {
      let id = el.getAttribute('data-crawler-evaluation-select');
      if (!id) {
        id = `evaluation-select-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        el.setAttribute('data-crawler-evaluation-select', id);
      }
      return { id, kind, text: (el.innerText || el.getAttribute('aria-label') || '').trim() };
    };
    const select = Array.from(document.querySelectorAll('select')).find(visible);
    if (select) return { ...mark(select, 'native'), options: Array.from(select.options).map((o, index) => ({
      index, value: o.value, text: o.textContent || '', disabled: o.disabled || o.parentElement?.disabled === true
    })) };
    const trigger = Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button, [tabindex], [class*="select"], [class*="dropdown"]')).find(el => {
      if (!visible(el) || ['INPUT', 'TEXTAREA'].includes(el.tagName)) return false;
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox' ||
        /^(?:choose|select|pick)\s+(?:a\s+|your\s+)?(?:start\s+)?(?:time|date|day)$/i.test(text);
    });
    return trigger ? mark(trigger, 'custom') : null;
  });
}

async function chooseEvaluationDropdown(page, dropdown, click, log = console.log) {
  if (!dropdown) return { handled: false, selected: false };
  if (dropdown.kind === 'native') {
    const option = chooseEvaluationOption(dropdown.options);
    if (!option) return { handled: true, selected: false };
    const control = page.locator(`[data-crawler-evaluation-select="${dropdown.id}"]`);
    log('Passive evaluation dropdown detected. Choosing:', option.text.trim());
    await control.selectOption({ index: option.index });
    return { handled: true, selected: true };
  }
  const control = page.locator(`[data-crawler-evaluation-select="${dropdown.id}"]`);
  if (!await click(control, 'evaluation dropdown')) return { handled: true, selected: false };
  await page.waitForTimeout(250);
  const options = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] button, [role="listbox"] li'));
    return elements.map((el, index) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) ||
          s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
      const id = `evaluation-option-${Date.now()}-${index}`;
      el.setAttribute('data-crawler-evaluation-option', id);
      return { id, text: (el.innerText || el.textContent || '').trim(),
        value: el.getAttribute('data-value') ?? el.getAttribute('value') ?? 'option',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' };
    }).filter(Boolean);
  });
  const option = chooseEvaluationOption(options);
  if (!option) return { handled: true, selected: false };
  log('Passive evaluation dropdown detected. Choosing:', option.text);
  const selected = await click(page.locator(`[data-crawler-evaluation-option="${option.id}"]`), `evaluation option ${option.text}`);
  return { handled: true, selected };
}

module.exports = { chooseEvaluationOption, findEvaluationDropdown, chooseEvaluationDropdown };
