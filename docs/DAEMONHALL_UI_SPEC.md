# DAEMONHALL UI Spec

Status: working canonical spec for the frontend/user journey.

Source material:
- Nikolai brand bible: loud name, sealed lips; quiet goes in, chaos comes out.
- Nikolai concept/story doc: daemon / whisper / seal must each be myth, product, and feeling at once.
- Nikolai feedback on Ocean's first spec: keep loops separate, do not rush terminal/input into the door, support voice whisper, make daemon creation extensible, combine binding + funding, delay reveal/aftermath details.

Name note: the source docs say PANDEMONIUM. The current product name/wordmark is DAEMONHALL. The brand logic still applies.

## North Star

DAEMONHALL is a market you cannot see into.

The player does not trade directly. The player whispers instructions to a daemon, seals that whisper, and sends the daemon into a closed hall. The house, the other players, and the player cannot inspect the hidden market during live play. At reveal, every whisper, action, outcome, and fingerprint becomes checkable.

Core promise:

> everyone plays blind, including the house — and you can prove it.

Core feeling:

> quiet goes in. chaos comes out.

## Non-negotiable Brand Rules

- Silence is the setup. The reveal is the punchline.
- Do not make it feel like a casino.
- No jackpots, hype countdowns, FOMO banners, cheerful gradients, green hacker terminal, or trading-dashboard clutter.
- The wordmark is the loud object. Everything else is small, dark, restrained, and precise.
- The terminal glows silver, not green.
- Violet is only for confidentiality/proof moments: lock, only-you, verify, fingerprint, key.
- Ember is rare. It is light leaking through a seal, never a normal button fill. Save major ember for reveal.
- Proof copy should not say “trust us.” It should say, in effect: check it yourself.
- Cryptography should be introduced through myth-language first: seal, key, fingerprint, reveal.
- Hidden state must never leak through UI decoration, copy, statuses, or animation.

## Vocabulary Mapping

- DAEMONHALL: the sealed world / hall where daemons gather.
- Daemon: demon, background process, and user proxy into a place the user cannot enter.
- Whisper: secret, instruction field, lowered voice.
- Seal / pact / sign: commitment point; wallet/email signature; no taking it back.
- Key / decrypt: only the user can see their own private truth.
- Fingerprint: public hash/commitment; proof visible, contents hidden.
- The dark: market invisibility; no charts, no positions, no orderbook.
- Status words: vibe/process condition, never position disclosure.
- The boxes open: reveal moment; every vow breaks at once.

## Current Loop Priority

Build piece by piece in this order:

1. Loop 0 — The Door
2. Loop 1 — The Threshold
3. Loop 2 — The Whisper
4. Loop 3 — The Dark Answers
5. Loop 4 — Seal + Stake / Binding
6. Loop 5 — Private Daemon Reveal
7. Loop 6 — The Wait Room
8. Later — Countdown breach, reveal, aftermath

Reveal and aftermath are intentionally deferred. Do not spend design/engineering time there until loops 0–6 feel right.

---

# Loop 0 — The Door

## Purpose

The player arrives in the dark.

This loop is not onboarding. It is not a form. It is not the terminal yet. It is the first paradox: DAEMONHALL looks loud, but the page is silent.

The goal is to make the player want to approach.

## Player Feeling

- Intrigue
- Hush
- A sealed room nearby
- “The name promised noise. Why is it so quiet?”

## What the Player Sees

- Full-screen dark void.
- DAEMONHALL lockup as the only loud object.
- Drip/head mark above the wordmark using the original lockup geometry.
- Wordmark large, rude-scale, central.
- Cold halo behind the mark.
- Subtle grain/dust and vignette.
- Tiny status line only:
  - `● SEALED / HALL CLOSED`

## What the Player Does

For current Loop 0 implementation: nothing required yet.

Future interaction may allow “approach” through scroll/click/hold, but it should not appear as a normal CTA button on Loop 0. If added, it must feel like moving toward a light, not pressing a product CTA.

## What the Player Learns

- The hall is sealed.
- The product is quiet on purpose.
- The name/mark is the loud part; the interface is holding back.

## What Remains Hidden

- No terminal.
- No whisper input.
- No mic icon.
- No wallet/email auth.
- No funding copy.
- No proof/fingerprint explanation.
- No markets, charts, PnL, positions, or leaderboard.

## Visual / Motion Spec

- Use the supplied Loop 0 lockup composition.
- Halo breathes slowly.
- Status dot breathes slowly.
- Optional wordmark shimmer, clipped to the wordmark silhouette.
- Motion must be slow and restrained.
- No ember except possibly imperceptible warmth in the void; ideally none.

## Current Live Implementation

`https://daemonhall.repo.box` currently implements Loop 0 only.

---

# Loop 1 — The Threshold

## Purpose

The terminal enters the experience.

This is where we previously mixed Step 1 and Step 2. The terminal does not belong in Loop 0 as an active form. Loop 1 begins only once the user approaches the light.

The player learns the rule without a tutorial:

> mortals can’t go in — only daemons can.

## Player Feeling

- Standing at an edge
- The friction is gone
- “I can’t enter, but something can enter for me”

## Entry From Loop 0

The transition should feel like approaching a faint pool of terminal light in the dark.

Possible triggers:
- scroll down
- click/hold the status/light
- keyboard Enter/Space/ArrowDown
- mobile tap/press

The transition should not feel like navigating to a new web page. The hall stays. The terminal emerges from it.

## What the Player Sees

A faint terminal light resolves into a thin silver terminal surface. Copy appears in beats:

- `mortals can’t go in.`
- `only daemons can.`
- `tell one what to do.`

The terminal should still be mostly empty. The rule arrives before the field.

## What the Player Does

- Approaches the terminal.
- Reads the rule.
- Continues naturally into the whisper field when it appears.

## What the Player Learns

- The user is not the trader.
- The user is the voice.
- The daemon is the hand.
- The daemon is the proxy into a place the user cannot go.

## What Remains Hidden

- No wallet/email auth yet.
- No funding yet.
- No generated daemon name yet.
- No markets or live state.
- No proof details beyond the feeling of a sealed threshold.

## Visual / Motion Spec

- Terminal surface is silver/monospace/thin-line, not green.
- It should feel like a pool of light in black.
- Use scanline/hairline glow very sparingly.
- Do not introduce panels/cards unless they feel sealed and modular.
- Copy should be short, lowercase or restrained caps depending on composition.

## Current Implementation Notes

- The previous standalone threshold area was removed after review because it did not work visually.
- The copy beats remain: `mortals can’t go in.`, `only daemons can.`, `tell one what to do.`
- Live preview now shows those copy beats first, then a redesigned terminal surface slides over/covers the copy and reveals the whisper field. The copy should not stack above the terminal.
- Door status shows a live ticking results countdown (`boxes open in …`) instead of static `hall closed`; current placeholder target is `2026-06-15T00:00:00Z` and should be updated once the exact results time is confirmed.
- Do not rebuild the previous separate threshold panel treatment.

---

# Loop 2 — The Whisper

## Purpose

The player gives the daemon its instruction before auth, funding, or bureaucracy.

This is the first real product action.

## Player Feeling

- Intimacy
- Lowered voice
- “I already put myself into this”

## What the Player Sees

A single whisper field at the terminal.

Suggested copy:

- Label: `tell it what to do — quietly`
- Placeholder: `whisper your daemon’s orders...`
- Support line: short enough to avoid mobile overflow; current implementation uses `only you hear this.`

## Voice Input Requirement

The whisper must be easy to provide by voice.

UI requirements:
- Text input remains primary and always available.
- Mic button is first-class, not buried.
- Browser asks for microphone permission when tapped.
- If speech-to-text is available, transcribe into the whisper field.
- If mic permission works but STT is unavailable, show that voice capture is unavailable and keep text input active.
- If mic denied, recover gracefully and keep text input active.
- The user must review/edit final text before sealing.
- The committed artifact is final text, not raw audio.

## What the Player Does

- Types or speaks a strategy/instruction.
- Reviews the resulting text.
- Continues only when ready.

## What the Player Learns

- Their words matter.
- The daemon will be born from the whisper.
- The whisper is private, but not yet sealed.

## What Remains Hidden

- Daemon name and form.
- Any inferred strategy classification.
- Any market or position data.
- Wallet/funding details.

## Validation

- Empty whisper cannot proceed.
- Vague whisper can be warned, but tone must not become SaaS/corporate.
- Never say “invalid strategy.” Prefer world-consistent language like: `the hall heard almost nothing`.

## Current Implementation Notes

- Live preview starts at Loop 0, transitions through Loop 1, then automatically reveals Loop 2 after the threshold copy finishes.
- Loop 2 shows exactly one small label above the field, one placeholder inside it, one support line below, a first-class mic button, and a restrained `let the dark answer` continuation that appears after text exists.
- Final whisper state must not show ghosted threshold copy, duplicate placeholder layers, or typewriter residue.
- The terminal top glitch/static band was removed; any texture should remain uniform/subtle across the screen, not concentrated on the input.
- The whisper area is centered in a padded mobile-safe container so text does not touch or clip at viewport edges.
- Background is near-black with only faint low-opacity violet glow behind the wordmark.
- The mic button uses browser SpeechRecognition when available, otherwise probes microphone permission and falls back to typed text.
- The user can review/edit the final text before continuing.
- There is intentionally no seal, no auth, no wallet/email, no funding amount, no daemon name, and no daemon reveal in Loop 2.

---

# Loop 3 — The Dark Answers

## Purpose

The user’s words cause something to stir, but it is not yet owned or revealed.

This creates anticipation before binding.

## Player Feeling

- Something heard me
- A reward is held just out of reach
- I want to take the key

## What the Player Sees

- The terminal reacts to the whisper.
- A presence/silhouette/static/sealed sigil appears.
- The daemon’s true name is obscured.
- Copy example: `something answered. its true name is sealed.`

## What the Player Does

- Moves toward binding the pact.

## What the Player Learns

- The whisper has consequences.
- The daemon exists in draft form.
- To learn its name/form, the player must bind it.

## What Remains Hidden

- True daemon name.
- Epithet.
- Final visual form.
- Strategy classification details.
- Any market info.

## Current Implementation Notes

- Clicking `let the dark answer` after whisper text transitions into Loop 3.
- The whisper terminal recedes and a sealed presence/sigil appears inside the same silver terminal surface.
- Copy is intentionally minimal: `something answered.` / `its true name is sealed.`
- The true name remains masked and the next action is only a non-functional preview: `bind comes next`.
- No auth, wallet, funding, pact signing, daemon reveal, market info, or strategy detail is present yet.

---

# Loop 4 — Seal + Stake / Binding

## Purpose

Binding, signing, and funding should be one psychological moment.

This is not separate “connect wallet” then “deposit” then “confirm.” It is one pact.

## Player Feeling

- Point of no return
- Finish line, not gate
- Ownership
- Small thrill

## Product Requirements

- User chooses how much to put in play during binding.
- First `$5` is on the house.
- If the user chooses only the house stake, the flow can proceed without deposit friction.
- If the user adds more than `$5`, handle USDC funding/deposit in this same flow.
- Signing/binding posts the public fingerprint of the sealed whisper.
- Wallet primary; email/social fallback if supported.
- USDC-only for MVP.

## What the Player Sees

A pact/seal panel with short promises:

- `your whisper is sealed`
- `a fingerprint is posted`
- `your key opens only your truth`
- `$5 house stake included`
- optional amount selector for extra USDC

Primary action language should be seal/pact language, not generic finance language.

Possible action:

- `seal the pact`

## What the Player Does

- Selects stake amount.
- Signs or authenticates.
- Adds USDC if above house stake.
- Commits.

## What the Player Learns

- The whisper is now sealed.
- The public can see a fingerprint, not the content.
- Only the user has the key to their private truth.

## What Remains Hidden

- Whisper content from others/house.
- Daemon’s full behavior.
- Positions/market state.

## Proof Copy Rule

Do not over-explain cryptography upfront. Use seal/fingerprint/key language first, with expandable proof details only if needed.

## Current Implementation Notes

- Loop 4 is currently a frontend-only story prototype; it does not call a backend, wallet, signer, or payment flow.
- Clicking `bind the pact` from Loop 3 opens a pact screen with four short promises: whisper sealed, fingerprint posted, key opens only your truth, and `$5 house stake included`.
- Stake buttons (`$5 house`, `$25`, `$100`) are visual/test-only and update the deterministic prototype fingerprint/daemon seed only.
- The prototype explicitly says `prototype only. no wallet. no backend. the story continues.`
- Clicking `seal the pact` advances to private daemon reveal.

---

# Loop 5 — Private Daemon Reveal

## Purpose

Reward the player for binding.

The seal breaks for the user alone: the daemon’s name and form decrypt privately.

## Player Feeling

- “Oh no, that’s me.”
- Recognition
- Comedy with bite
- Ownership

## Extensible Daemon Creation Engine

Do not design this as choosing from 3 archetypes.

The UI and system must assume many participants and many generated daemon identities.

Daemon identity should be generated from composable traits:
- process-style daemon name
- epithet
- origin line derived from the whisper
- sealed visual/sigil traits
- behavior/status vocabulary

Examples from brand direction:
- `fomod — THE LATECOMER, FIRST OF ITS PANIC`
- `hopiumd — still believing`
- `rugd — trusted the wrong gate`

## What the Player Sees

- Daemon name.
- Epithet.
- Short roast/origin line.
- Partial sealed face/sigil/form.
- Commitment fingerprint.
- Violet privacy cue: `visible only with your key`.

## What Remains Hidden

- Positions.
- Future actions.
- Full face/form if we choose to keep some of it sealed until reveal.
- Other users’ private daemon truth.

## Current Implementation Notes

- Loop 5 is currently frontend-only and deterministic from the whisper text/stake; it does not use a real daemon creation backend yet.
- Generated identity includes process-style daemon name, uppercase epithet, origin/roast line derived from the whisper, masked/sigil form, and shortened fingerprint.
- Violet privacy cue is present as `visible only with your key`.
- Clicking `send it into the hall` advances to the wait room.

---

# Loop 6 — The Wait Room

## Purpose

The daemon departs. The user waits at the wall.

This is the sealed live-play state.

## Player Feeling

- Anxious faith
- “Only I can see this”
- A crowd nearby that cannot be read

## Public Surface

Allowed public data:
- daemon display name
- PnL percentage/rank if approved by game design
- coarse status word
- safe hall murmurs
- public billboard line if agents get one

Forbidden public data during sealed phase:
- positions
- orderbook
- hidden market state
- other players’ balances
- agent reasoning/transcripts
- exact event details that allow inference of private state

## Private Surface

Allowed only to the user with key:
- own decrypted balance
- own daemon private summary if safe
- own seal/fingerprint details

## Safe Daemon Status Vocabulary

Statuses describe condition/vibe, not holdings.

Initial pool:
- `running`
- `sleeping`
- `chasing`
- `waiting`
- `circling`
- `listening`
- `hungry`
- `hesitating`
- `overclocked`
- `quiet`
- `zombie`
- `killed -9`
- `sealed`
- `drifting`
- `committed`
- `wrong-footed`
- `still believing`

Status derivation rule:

A status may be derived from coarse process state, broad PnL bands, elapsed inactivity, or lifecycle state. It must not reveal specific hidden positions, orders, counterparties, market direction, or trade timing.

## Hall Murmurs

Allowed examples:
- `▸ a market resolved`
- `▸ something moved in box 88`
- `▸ a daemon went quiet`

Design trick:

If precise copy would help a trader infer hidden state, make it poetic/noisy instead of precise.

## Current Implementation Notes

- Loop 6 is currently a frontend-only sealed wait-room prototype.
- It shows the user's daemon display name, user's own decrypted prototype balance, safe status word, and poetic hall murmur.
- After the daemon card, the user sees `listen at the wall` rather than the full leaderboard crammed into the card.
- `listen at the wall` opens a full-screen scrollable hall-wall view: a peek into muffled aggregate movement, not a window into hidden state.
- Hall-wall copy should preserve the concept language: `muffled through stone`, `crowd you cannot read`, `echoes, not windows`.
- It includes public wall/leaderboard material from the concept doc: aggregate values (`volume`, `trades`, `sealed boxes`, `fingerprints`) plus a leaderboard of daemon process names, coarse percentage pulse, and safe status words.
- The leaderboard intentionally avoids positions, orderbook, hidden market state, other player balances, agent reasoning, exact trade timing, or exact event details.
- Prototype values are deterministic/noisy frontend values until backend/indexer integration is explicitly wired.
- `step back` closes the hall wall; `whisper again` restarts the local prototype flow without touching backend state.

---

# Daemon Asset Generation Spec

Daemon gallery assets are pregenerated and assigned randomly. They are not generated during user onboarding.

Hard rule for image generation:

- Each output image must contain exactly one primary creature.
- No contact sheets, grids, panels, split-image layouts, multiple variants, duplicated full-body figures, or side-by-side silhouettes.
- Prompt language must explicitly say: `ONE SINGLE CHARACTER ONLY`, `exactly one isolated full-body portrait`, `one creature only`, `no other characters`, `no panels`, `no grid`, `no contact sheet`, and `no duplicated figures`.
- Labels/text are rendered in code, never generated into the image.
- After generation, run a visual audit and reject any image with multiple creatures, panel artifacts, text artifacts, or unclear primary silhouette.
- Keep only DAEMONHALL-locked DAEMON/GARGOYLE/HARPIE style unless intentionally expanding the bestiary.

Reusable prompt prefix:

> ONE SINGLE CHARACTER ONLY. Create exactly one isolated full-body DAEMONHALL bestiary portrait. Centered full-body concept art, one creature only, no other characters, no panels, no grid, no contact sheet, no duplicated figures, no text.

Current internal gallery:

- `https://darkbox-mic.repo.box/daemons.html`
- Assets: `apps/telegram-miniapp/public/daemons/`
- Manifest: `apps/telegram-miniapp/public/daemons/manifest.json`
- Three.js preview entry: `apps/telegram-miniapp/src/daemon-gallery.ts`

Internal Three.js effect target:

- Gallery cards select one daemon at a time.
- The selected daemon renders in a bottom shader stage.
- Baseline animation recipe: 95% static image, 3% shader displacement/flicker, 2% rare glitch slice frames.
- Idle: slow breathe, scanline/noise shimmer, tiny vertex displacement.
- Hover/selected: brighter lavender rim/glow and sharper contrast.
- Whisper/microphone: microphone RMS increases shader displacement, chromatic split, glow, and glitch-slice probability.
- Keep this internal until the effect is approved; do not place the gallery or shader stage on the main onboarding page.

---

# Later Loops — Deferred

## Countdown Breach

The final minute can begin to break the silence.

- Terminal strains.
- Seams glow ember.
- Status dots accelerate.
- Still no early hidden-state reveal.

## Reveal

This needs a separate spec later.

High-level direction:
- one maximalist eruption
- ember finally allowed
- `THE BOXES OPEN.`
- whisper/action/outcome/fingerprint match cards
- proof is cold and checkable after the scream

## Aftermath

Also deferred.

High-level direction:
- ember dies down
- hall returns dark
- final ranking, personal daemon story, replay/proof bundle, share card

---

# Implementation Discipline

Before implementing any loop:

1. Check this spec.
2. Implement only that loop’s scope.
3. Deploy to `https://daemonhall.repo.box`.
4. Verify live HTTPS and screenshot if possible.
5. Update this spec if product decisions changed.

Do not let later-loop UI leak backward into earlier loops.

Common failure to avoid:

- Loop 0 must not contain Loop 1/2 UI.
- Loop 1 must not contain auth/funding.
- Loop 2 must not contain daemon reveal.
- Loop 4 must combine seal + stake, not split into generic web3 steps.
