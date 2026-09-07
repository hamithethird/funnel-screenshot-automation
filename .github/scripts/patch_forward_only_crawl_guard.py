from pathlib import Path

path = Path('funnel-crawler-multiscreen.js')
source = path.read_text()

# 1) Add a hard safety flag near the main loop so the live crawler never rewinds
#    or reloads the user's primary funnel session during branch discovery.
flag_marker = '  const MAX_SCREENS = 100;'
flag_code = '''  // SAFETY: the primary crawl is forward-only. Branch probing used to mutate\n  // the live SPA session, then call Back/goBack/page.goto to restore earlier\n  // questions. On stateful funnels that can reset progress to page 1 and can also\n  // consume/skips screens before the numbered capture loop sees them. Keep branch\n  // discovery disabled on the live page until it runs in an isolated checkpointed\n  // context. Same-page selection/popup capture still works through handleAnswerGroup.\n  const LIVE_BRANCH_PROBING_ENABLED = false;\n\n'''
if 'const LIVE_BRANCH_PROBING_ENABLED = false;' not in source:
    if flag_marker not in source:
        raise SystemExit('Could not find MAX_SCREENS insertion point.')
    source = source.replace(flag_marker, flag_code + flag_marker, 1)

# 2) Gate branch exploration in the numbered loop. The normal advance path remains
#    active, so every page is captured before the crawler interacts with it.
old_branch = '''      } else if (state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {\n        acted = await exploreAnswerBranches(state, screenNumber);\n      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {\n'''
new_branch = '''      } else if (LIVE_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {\n        acted = await exploreAnswerBranches(state, screenNumber);\n      } else if (!LIVE_BRANCH_PROBING_ENABLED && state.group.length >= 2 && !isSpeechInputScreen(state.pageText) && !hasSkipEscapeChoice(state)) {\n        console.log('Forward-only safety mode: skipping destructive branch probing on the live funnel session. Taking the normal answer path instead.');\n      } else if (state.group.length >= 2 && isSpeechInputScreen(state.pageText)) {\n'''
if old_branch in source:
    source = source.replace(old_branch, new_branch, 1)
elif 'Forward-only safety mode: skipping destructive branch probing' not in source:
    raise SystemExit('Could not find the branch exploration call in the main loop.')

# 3) Add numbered-page history guards. If the SPA unexpectedly returns to a page
#    already captured earlier in this run, stop BEFORE taking another screenshot.
history_marker = '  const MAX_SCREENS = 100;\n  for (let screenNumber = 1; screenNumber <= MAX_SCREENS; screenNumber++) {'
history_replacement = '''  const MAX_SCREENS = 100;\n  const numberedPageHistory = new Map();\n  let lastNumberedFingerprint = '';\n  let lastNumberedUrl = '';\n\n  for (let screenNumber = 1; screenNumber <= MAX_SCREENS; screenNumber++) {'''
if history_marker in source:
    source = source.replace(history_marker, history_replacement, 1)
elif 'const numberedPageHistory = new Map();' not in source:
    raise SystemExit('Could not find main screen loop.')

# Insert guard after state inspection / any skipNextNumbered processing, immediately
# before paywall detection and screenshot naming.
guard_marker = '    const paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, \'0\')}.png`);'
# Current file may use let paywallState after popup patch.
if guard_marker not in source:
    guard_marker = '    let paywallState = await inspectPaywallState();\n    const filename = path.join(OUTPUT_DIR, `${String(screenNumber).padStart(2, \'0\')}.png`);'

guard_code = '''    const numberedFingerprint = normalizeContextText(state.pageText || '');\n    const numberedUrl = sanitizeUrl(page.url());\n    const numberedKey = `${numberedUrl}::${numberedFingerprint}`;\n    const previousScreen = numberedPageHistory.get(numberedKey);\n    if (previousScreen && previousScreen < screenNumber - 1) {\n      console.log(`RESET GUARD: current page matches previously captured screen ${String(previousScreen).padStart(2, '0')}. The funnel appears to have jumped backward/reset. Stopping before creating duplicate screenshots.`);\n      break;\n    }\n\n    // Same URL is normal for SPAs, so only treat an exact prior URL+content state as\n    // a reset. Consecutive identical states are allowed to reach the normal\n    // no-advancement check below rather than being mislabeled as a reset.\n    if (numberedFingerprint) numberedPageHistory.set(numberedKey, screenNumber);\n    lastNumberedFingerprint = numberedFingerprint;\n    lastNumberedUrl = numberedUrl;\n\n'''
if 'RESET GUARD: current page matches previously captured screen' not in source:
    if guard_marker not in source:
        raise SystemExit('Could not find paywall/screenshot block for reset guard insertion.')
    source = source.replace(guard_marker, guard_code + guard_marker, 1)

# 4) Make the dangerous direct URL restoration impossible even if branch probing is
#    manually re-enabled later. Back/goBack may still be used only inside that old
#    experimental function, but page.goto(questionUrl) can no longer reset the SPA.
old_goto = '''    // Direct navigation is the last resort only. It is accepted only if the exact\n    // original question prompt + answer set can be verified after loading.\n    try {\n      console.log('Browser history did not restore the question. Trying the saved question URL as a last resort.');\n      await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });\n      const matched = await inspectAndMatch(1000);\n      if (matched) return matched;\n    } catch {}\n\n    console.log('Unable to restore the exact original branch question safely.');\n'''
new_goto = '''    // Never reload the saved question URL on the live SPA session. Many funnels\n    // keep progress outside the URL; page.goto(questionUrl) can silently restart\n    // onboarding from page 1 even when the URL is unchanged.\n    console.log('Browser history did not restore the question. Direct URL restoration is disabled in forward-only safety mode.');\n    console.log('Unable to restore the exact original branch question safely.');\n'''
if old_goto in source:
    source = source.replace(old_goto, new_goto, 1)
elif 'Direct URL restoration is disabled in forward-only safety mode.' not in source:
    raise SystemExit('Could not find destructive branch page.goto fallback.')

path.write_text(source)
print('Applied forward-only crawl safety patch.')
