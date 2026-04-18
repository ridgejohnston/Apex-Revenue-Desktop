# Our Promise: Apex Will Never Speak in Your Chat

One of the most common frustrations performers have with streaming tools is
watching the tool's name show up in their own chat, over and over, in front of
paying viewers. A recent forum post captures it exactly:

> *"I was in a room the other day, she was using your app. Don't know which one
> it was but no less than 13 times in 20 minutes did your name appear on her chat."*

That will never happen with Apex Revenue. **This is a product decision, a code
invariant, and a CI-enforced rule — not a promise we can quietly walk back
later.**

## The rule

Apex Revenue will not inject messages into your platform's chat box under any
circumstance unless **you** explicitly typed the message in an Apex UI control
and **you** clicked send.

This means:
- No "tip received" announcements posted by Apex.
- No "Apex Revenue is running" notifications to viewers.
- No auto-replies. No auto-thanks. No Apex-branded anything. Ever.
- When the AI engine suggests a message to send to a viewer, it is yours to
  copy, edit, paste, and send — never ours to post.

## How we enforce it

Three layers:

1. **Policy, in this document.** Written down, referenced in the code, and
   linked from the app's Settings modal.

2. **Runtime invariant.** `main/browser-view-guard.js` wraps every code path
   that could reach a platform's chat input. Any write request is rejected
   unless it carries an explicit `userInitiated: true` flag that can only be
   set by a direct performer action in the UI. Violations are logged.

3. **CI check.** `scripts/check-silent.js` runs on every commit. It greps the
   codebase for chat-selector strings paired with Apex-branded content. If it
   finds anything, the build fails.

## What about the AI features?

The Switchboard AI (coming in Phase 1) will draft replies to your private
messages. The draft appears in a panel *inside Apex*. You copy it, or you
click through to the platform's native PM window, and you paste and send
yourself.

The same rule applies to every AI feature after that: Apex drafts, you send.
If we ever ship something that feels like it's breaking this rule, report it
via the feedback button in the app and we'll treat it as a serious bug, not
a feature disagreement.

## Why this matters more than it looks

Performers live or die on the trust of their rooms. A tool that keeps chiming
in with its own branding — even in small ways — corrodes that trust. Over a
few weeks, it trains viewers to associate the performer with a third-party
product they didn't agree to. Over months, it makes the tool itself feel
parasitic.

Apex is built to be invisible to viewers. The performer is the show. The tool
is infrastructure.

---

*Last updated: April 2026 — v3.2.0 release*
