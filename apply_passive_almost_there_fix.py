from pathlib import Path

p = Path('funnel-crawler-multiscreen.js')
s = p.read_text()

old = """    /\\balmost (?:done|ready|there)\\b/,
"""
new = """    // \"Almost there\" is commonly a section/header label on active forms
    // (for example BetterMe height/weight/name steps). It must not by itself
    // classify a page as passive. Only the stronger completion phrases remain.
    /\\balmost (?:done|ready)\\b/,
"""
if old not in s:
    raise SystemExit('passive almost-there signal not found')
s = s.replace(old, new, 1)

old2 = """    const initialState = await inspectPage();
    const initialSignature = pageSignature(initialState);
    const initialUrl = sanitizeUrl(page.url());
    const passiveTransition = isPassiveTransitionScreen(initialState.pageText);
    const effectiveTimeoutMs = passiveTransition ? Math.max(timeoutMs, 60000) : timeoutMs;
"""
new2 = """    const initialState = await inspectPage();
    const initialSignature = pageSignature(initialState);
    const initialUrl = sanitizeUrl(page.url());
    // A page with a visible editable field is an ACTIVE FORM, never a passive
    // transition. This precedence is intentional: form intent outranks copy like
    // \"Almost There\", \"preparing\", or other generic shell text.
    const initialEditableInput = await hasVisibleEditableInput();
    const passiveTransition = !initialEditableInput && isPassiveTransitionScreen(initialState.pageText);
    const effectiveTimeoutMs = passiveTransition ? Math.max(timeoutMs, 60000) : timeoutMs;
"""
if old2 not in s:
    raise SystemExit('waitForActionableState initialization block not found')
s = s.replace(old2, new2, 1)

p.write_text(s)
