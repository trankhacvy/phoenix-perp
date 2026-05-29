# SuperNova — 30s Teaser · Remotion Script

**Product:** SuperNova — trade Phoenix perpetual futures on Solana, from inside Telegram.
**Goal:** 30s autoplay teaser for X/Twitter + landing-page hero. Make a Solana-native perp trader think *"wait, I can trade perps with one tap in Telegram — and it auto-protects me?"*

**Decisions locked (do not re-litigate):**
- Length: **30s** teaser (900 frames @ 30fps).
- Audience: **Solana-native perp traders.** Assume they know leverage, liq price, funding. No hand-holding.
- Heroes, in priority order: **① one-tap trade flow ② Guardian risk automation ③ live alerts/monitoring.**
- Narration: **on-screen kinetic text + music, NO voiceover.** Must read on muted autoplay.

---

## 0. Format & technical spec

| Param | Value | Note |
|---|---|---|
| Resolution | **1080 × 1920** (9:16 vertical) | The whole video is a phone screen — vertical is native. **Change `Root.tsx` from 1280×720.** Make a 1:1 (1080×1080) crop-safe alt later if needed for X. |
| FPS | **30** | matches scaffold |
| Duration | **900 frames / 30.0s** | |
| Safe area | keep text/buttons within central 1080×1620 | top/bottom 150px reserved for caption band + chain lockup |
| Tailwind | enabled (`@remotion/tailwind-v4`) | use it; define tokens in CSS |

---

## 1. Creative direction (the vibe)

- **Aesthetic:** dark "fintech terminal at night." Near-black canvas, a single hero **phone** floating in 3D-ish space, volumetric glow behind it in SuperNova accent. Think Linear/Phantom launch films, not stock SaaS.
- **The phone is the star.** ~70% of frames are a Telegram chat on a phone. We zoom/pan/parallax the phone; the *content inside* carries the story. Never show a desktop browser.
- **Motion principles:**
  - UI elements **spring in** (mass-y, slight overshoot), never linear fades.
  - Buttons get a real **tap state** (scale 0.96 + ripple) before each action — sells "one tap."
  - Numbers **count up / roll** (tabular-nums) instead of cutting.
  - Every scene transition is a **fast push/whoosh** (120–180ms), synced to a music transient.
- **Restraint:** one accent gradient, two type families, generous negative space. No drop-shadow soup, no more than 2 things animating at once (Remotion + Opus both choke on busy comps — keep layers shallow).

### Palette (define as CSS vars / Tailwind tokens)
```
--bg            #05050F   /* canvas, matches the app's PnL-card bg */
--surface       #0E0E1A   /* phone chrome / cards */
--tg-chat-bg    #0E1621   /* Telegram dark chat background */
--bubble-in     #17212B   /* bot message bubble */
--bubble-btn    #1C2733   /* inline keyboard button */
--text-hi       #FFFFFF
--text-lo       #8A97A3   /* secondary / timestamps */
--long-green    #14F195   /* Solana green = long / profit / confirm */
--short-red     #EA3943   /* short / loss / liq risk */
--nova          linear-gradient(135deg,#9945FF 0%,#14F195 100%)  /* SuperNova accent (Solana gradient) */
--phoenix       #FF6B35   /* Phoenix orange, sparing accent */
--warn          #F0B90B   /* ≥20× leverage warning */
```

### Type
- **Display / captions:** Space Grotesk (700/500) — already a project dependency (`@fontsource/space-grotesk`).
- **UI / body:** Inter (`@fontsource-variable/inter`). Use `tabular-nums` for all prices/sizes.
- Load via `@remotion/fonts` local loader, not Google CDN (offline-safe renders).

### Music & SFX
- One track, **~120–126 BPM**, electronic, dark-with-hope. Structure: airy intro (0–4s) → pulse builds (4–13s) → **DROP HIT on the fill ✅ (~13.3s)** → driving body (13–27s) → tail/lift on CTA (27–30s).
- SFX layer (subtle, −18dB under music): keyboard *tick* on `/long`, soft *tap* per button, *confirm chime* on fill, *notification pop* per alert in Scene 3, *spark/ignite* on logo.
- **Parameterize the beat grid** (see §3) so every keyframe can be nudged to land on a beat. This is the #1 thing that makes it feel pro vs slop.

---

## 2. Reusable React components to build (Telegram replica)

Build these as dumb, prop-driven components in `src/components/`. Replicate Telegram **dark theme** layout closely — credibility comes from accuracy.

| Component | Props | Notes |
|---|---|---|
| `<PhoneFrame>` | `children`, `glow?` | Rounded 1080-wide device, notch, subtle bezel, status bar (time `9:41`, signal/battery). Holds the chat. |
| `<ChatHeader>` | `name`, `subtitle` | "SuperNova ⚡️" + "bot" / "online". Back chevron, avatar (nova-gradient star). |
| `<BotBubble>` | `children`, `time` | Left-aligned `--bubble-in` bubble, rounded, sender avatar optional, timestamp + ✓✓. |
| `<UserBubble>` | `text`, `time` | Right-aligned, slightly tinted, for the typed `/long`. |
| `<InlineKeyboard>` | `rows: Btn[][]`, `pressedKey?` | Grid of `<KbButton>`. `pressedKey` drives the tap animation. |
| `<KbButton>` | `label`, `variant` (`default`/`confirm`/`cancel`/`star`), `pressed` | `confirm` = green fill, `star` = nova outline (default leverage). Tap = scale 0.96 + ripple. |
| `<QuoteCard>` | trade fields | The confirm card — see Scene 1 copy. Mono numbers, divider rows. |
| `<TxStatusPill>` | `state` (`confirming`/`success`) | ⏳ confirming → ✅ success morph, with Solscan link row. |
| `<PushNotif>` | `icon`, `title`, `body`, `accent` | iOS-style lock-screen notification card for Scene 3. |
| `<CaptionBand>` | `lines`, `progress` | Bottom kinetic caption (Space Grotesk). Word-by-word reveal. |
| `<ChainLockup>` | — | tiny footer: `Solana · Phoenix · Flight` with logos, persistent low-opacity from Scene 1 on. |

**Accuracy anchors (real product copy — use verbatim):** terminology is locked — "bot wallet", "trading account", "**margin**", "**position size**", "**liquidation price**". Buttons: `✅ Confirm Long`, `✕ Cancel`, `View on Solscan →`, `🎯 Set TP / SL`. Confirm copy = `⏳ Confirming on-chain… (usually 2–5s)`. Long=green, short=red. Funding shown with 🟢/🔴 dot.

---

## 3. Global parameters — PARAMETERIZE EVERYTHING

> Hard lesson from real Remotion work: the model hardcodes magic numbers and everything downstream breaks when you nudge one beat. Define every important moment as a named frame constant and derive the rest. Keep this in `src/timing.ts`.

```ts
export const FPS = 30;
export const DURATION = 900;           // 30.0s

// --- Beat grid (124 BPM → ~14.52 frames/beat). Snap keyframes to BEAT(n). ---
export const BPM = 124;
export const FPB = (60 / BPM) * FPS;   // frames per beat ≈ 14.52
export const BEAT = (n: number) => Math.round(n * FPB);
export const DROP = BEAT(27);          // ≈ frame 392 ≈ 13.1s — the fill hit (tune to track)

// --- Scene boundaries (start frame, length) ---
export const HOOK    = { start: 0,   len: 120 };  // 0.0 – 4.0s
export const TRADE   = { start: 120, len: 340 };  // 4.0 – 15.3s
export const GUARD   = { start: 460, len: 210 };  // 15.3 – 22.3s
export const ALERTS  = { start: 670, len: 140 };  // 22.3 – 27.0s
export const CTA     = { start: 810, len: 90  };  // 27.0 – 30.0s

// --- Trade-flow sub-beats (offsets from TRADE.start) ---
export const TF = {
  chatIn:    0,    // phone + chat appear, /long typed
  sizeStep:  30,   // size keyboard in
  tapSize:   75,   // tap $100
  levStep:   90,   // leverage keyboard in
  tapLev:    140,  // tap 10×
  quoteIn:   150,  // confirm card slides up
  tapConfirm:210,  // tap ✅ Confirm Long
  confirming:230,  // ⏳ pill
  filled:    280,  // ✅ success  (align ~DROP)
};

// --- Reusable spring presets ---
export const SPRING_UI   = { damping: 18, mass: 0.7, stiffness: 140 }; // element entrances
export const SPRING_TAP  = { damping: 12, mass: 0.4, stiffness: 220 }; // button press
export const PUSH_MS     = 160; // scene transition whoosh
```

Everything below references these. To re-time to your final music, you only touch `BPM`, `DROP`, and the scene `start/len`.

---

## 4. Scene-by-scene script

> Format per scene: **frames (seconds) · what's on screen · motion · caption text · audio.**
> Caption = the only words the viewer reads. Keep each ≤ 5 words, present tense, trader voice.

---

### SCENE 0 — HOOK · "Perps. In Telegram." 🔥
**Frames 0–120 (0.0–4.0s)**

**On screen:**
- Cold open on `--bg`. A point of light at center.
- **0–45f:** light **ignites** into the SuperNova mark (nova-gradient star/burst) with a quick spark SFX. Faint volumetric glow blooms behind.
- **45–90f:** wordmark **SuperNova** types/springs in under the mark.
- **70–115f:** caption line snaps in beneath.
- **100–120f:** everything scales down + pushes back as the **phone** flies in from bottom (lead-in to Scene 1).

**Motion:** logo ignite = scale 0→1 with `SPRING_UI` + glow opacity 0→1; wordmark = per-letter stagger (3f apart). Hold dead-still 30f (let it breathe), then the push.

**Caption:** `Perps. Inside Telegram.` → (swap at 75f) `One tap. On Solana.`

**Audio:** airy pad + the ignite spark. First kick lands at ~`BEAT(8)` to lead into Scene 1.

**Gotcha:** resist adding particles/confetti — keep the ignite to ONE glow layer + the mark. Busy = slop.

---

### SCENE 1 — ONE-TAP TRADE ⚡️ *(the money shot — give it the most time & polish)*
**Frames 120–460 (4.0–15.3s)** · sub-beats from `TF`

The phone is now hero, centered, slight parallax. Telegram dark chat with `<ChatHeader name="SuperNova ⚡️" subtitle="bot">`.

**Beat A — intent (120–150f / `chatIn`):**
- `<UserBubble text="/long SOL" time="9:41">` springs in from right, keyboard-tick SFX.
- Bot replies `<BotBubble>`: **"SOL · LONG — how much margin?"** with balance line `Available: $2,480 · trading account`.

**Beat B — size (150–210f / `sizeStep`→`tapSize`):**
- `<InlineKeyboard>` rows: `[ $25 ][ $50 ][ $100 ][ $250 ]` / `[ Custom ]`.
- At `tapSize` (≈195f): **`$100` presses** (scale 0.96 + ripple), tap SFX. Selected button flashes nova outline.

**Beat C — leverage (210–270f / `levStep`→`tapLev`):**
- Bot bubble: **"Leverage?"**. Keyboard `[ 2× ][ 5× ][ 10× ⭐ ][ 20× ][ 50× ]` (10× is `star` variant = current default).
- At `tapLev` (≈260f): **`10×` presses**. (If you want to flash the safety story: briefly hover 20× and show inline `⚠️ High leverage` in `--warn`, then settle on 10×. Optional — costs ~15f.)

**Beat D — confirm quote (270–330f / `quoteIn`→`tapConfirm`):**
- `<QuoteCard>` slides up over the keyboard. Numbers **roll in** (count-up), not cut. Card content (verbatim structure — this is the real confirm layout):
  ```
  SOL · LONG            (Cross)
  ───────────────────────────
  Entry        ~$184.20
  Margin       $100.00
  Position size $1,000.00  (10×)
  Max slippage  0.5%
  Liq. price   ~$167.30
  ───────────────────────────
  [ ✅ Confirm Long ]   [ ✕ Cancel ]
  ```
- At `tapConfirm` (≈330f): **`✅ Confirm Long` presses** (green), confident tap SFX.

**Beat E — confirming (330–400f / `confirming`):**
- Card morphs to `<TxStatusPill state="confirming">`: **`⏳ Confirming on-chain… (usually 2–5s)`**. A thin nova progress bar fills. Music **tension builds** here — this is the pre-drop.

**Beat F — FILLED (400–460f / `filled` ≈ `DROP`):**
- **DROP HIT.** Pill snaps to `state="success"`: green check pops (`SPRING_TAP`, slight overshoot), confirm chime.
  ```
  ✅ Long SOL filled
  Size $1,000 · 10× · entry $184.20
  [ View on Solscan → ]  [ 🎯 Set TP / SL ]
  ```
- Phone does a tiny celebratory recoil. Caption fires on the hit.

**Captions (sequenced):**
`Pick a market` → `Set your size` → `Choose leverage` → `Confirm the quote` → **`Filled. On-chain.`** (the last lands on the DROP, bigger type).

**Audio:** per-button taps, rising synth through confirming, **drop + confirm chime** on fill.

**Gotchas:**
- Keep the chat **scroll-locked** — let new bubbles push up naturally; don't animate a fake finger unless you can do it cleanly (a finger done badly looks awful — the tap-state on buttons is enough).
- z-index: QuoteCard sits ABOVE keyboard, BELOW chat header. State this explicitly in code or layers fight.
- Numbers must be tabular-nums or the roll-up jitters horizontally.

---

### SCENE 2 — GUARDIAN 🛡 *"Set it. Forget it. It protects you."*
**Frames 460–670 (15.3–22.3s)**

Fast push transition. Same phone, new bot screen: `/guardian` risk rules.

**Beat A — the rules screen (460–510f):**
- Bot bubble header: **"🛡 Guardian — auto-protection"**. Below, two rule rows toggle ON in sequence (toggle slides + nova glow, soft tick each):
  - `Trailing stop · 5%` → toggles **ON**
  - `Move to breakeven · +3%` → toggles **ON**
- (Optional 3rd, dimmer: `Auto-reduce if margin < 20%` — shows depth without clutter.)

**Beat B — "armed" seal (510–610f):**
- A shield icon assembles (stroke-draw, then fill nova) center-screen over the phone; subtle ring pulse. Caption underneath.

**Beat C — it fires (610–670f):**
- Cut back to chat. A **Guardian push** arrives as a `<BotBubble>` with accent:
  ```
  🛡 Guardian: stop moved to breakeven
  SOL · LONG now risk-free · trailing at $186.40
  ```
- The bubble glows green briefly — the payoff: it acted *for* you, on-chain, while you did nothing.

**Captions:** `Trailing stop.` → `Breakeven. Auto.` → **`It guards while you sleep.`**

**Audio:** two toggle ticks → a low "arm" swell on the shield → a confident notch when the Guardian alert lands.

**Gotchas:** the shield should **draw then fill** (two stages), not just fade in. A faded-in icon reads as stock. Keep the rule list to 2 (3 max) — readability on autoplay.

---

### SCENE 3 — LIVE ALERTS & MONITORING 🔔 *"You're never blindsided."*
**Frames 670–810 (22.3–27.0s)**

Push transition to the phone **lock screen** (or pull camera back so notifications stack in front of the device). Three `<PushNotif>` cards cascade in, each landing on a beat with a *pop* — staggered ~30f apart, newest on top, older ones settle down/blur slightly (depth).

**Notif 1 (700–730f) — risk, `--short-red` accent:**
`🚨 Liquidation risk · SOL` — `Cross margin at-risk tier. Add margin?`

**Notif 2 (730–760f) — price, nova accent:**
`🔼 BTC crossed $72,000` — `Your price alert triggered.`

**Notif 3 (760–800f) — monitor/social, `--long-green` accent (the differentiator):**
`👁 Trader you follow opened LONG SOL · 20×` — with a mini `[ Copy Long ]` button on the card.

**Beat (800–810f):** the three cards compress into a tidy stack as we push to CTA.

**Captions:** `Risk alerts.` → `Price alerts.` → **`Follow the sharks.`**

**Audio:** three distinct notification pops (slightly different pitch each), tight on the beat.

**Gotchas:** don't let all 3 animate simultaneously — **stagger**. Each card: slide-down + spring settle + the ones behind it nudge back. The `Copy Long` mini-button on Notif 3 is the hook to leave them on — make it legible.

---

### SCENE 4 — CTA / OUTRO ⭐️
**Frames 810–900 (27.0–30.0s)**

Phone recedes and dissolves into glow. We land back on the brand, mirroring the hook (bookend).

**On screen (assemble in this order):**
- **810–840f:** SuperNova mark re-ignites (callback to Scene 0, faster).
- **840–870f:** wordmark + handle spring in: **`SuperNova`** / **`@SuperNova_bot`** (use the real bot handle).
- **855–885f:** primary CTA pill, nova-gradient, gentle pulse: **`Open Telegram → Trade now`**.
- **870–900f:** `<ChainLockup>` resolves to full opacity at the very bottom: **`Solana · Phoenix · Flight`** with logos.
- Final 10f: subtle hold, glow breathes, end on the mark.

**Caption (single, big):** `Perps, one tap away.`

**Audio:** music lifts/resolves; one last soft spark on the re-ignite; tail reverb out.

**Gotchas:** the CTA pill must be unmistakably tappable (it IS the conversion). Don't end on a hard cut — let the last frame hold ~0.3s of glow so a looping autoplay re-entry into Scene 0 feels seamless (bookend).

---

## 5. Timeline at a glance

| Scene | Frames | Time | Hero beat |
|---|---|---|---|
| 0 · Hook | 0–120 | 0.0–4.0s | Logo ignite → "Perps. Inside Telegram." |
| 1 · Trade | 120–460 | 4.0–15.3s | /long → size → lev → confirm → **FILLED (drop)** |
| 2 · Guardian | 460–670 | 15.3–22.3s | Toggle trailing/breakeven → shield → it fires |
| 3 · Alerts | 670–810 | 22.3–27.0s | 3 push notifs cascade · "Follow the sharks" |
| 4 · CTA | 810–900 | 27.0–30.0s | Re-ignite → @handle → "Trade now" → chain lockup |

---

## 6. Remotion structure

```
src/
  Root.tsx                 // <Composition id="SuperNovaTeaser" 1080x1920 30fps 900f>
  timing.ts                // §3 constants — single source of truth
  index.css                // palette vars + font-face
  SuperNovaTeaser.tsx      // top-level: <Series> or absolute <Sequence>s per scene
  scenes/
    Hook.tsx
    Trade.tsx
    Guardian.tsx
    Alerts.tsx
    Cta.tsx
  components/               // §2 Telegram replica + brand
    PhoneFrame.tsx ChatHeader.tsx BotBubble.tsx UserBubble.tsx
    InlineKeyboard.tsx KbButton.tsx QuoteCard.tsx TxStatusPill.tsx
    PushNotif.tsx CaptionBand.tsx ChainLockup.tsx NovaMark.tsx
  lib/
    useTap.ts               // shared button-press spring (SPRING_TAP)
    rollNumber.tsx          // count-up tabular-nums helper
public/
  audio/track.mp3  audio/sfx/*.mp3
  fonts/SpaceGrotesk-*.woff2  fonts/Inter-*.woff2
  logos/solana.svg logos/phoenix.svg
```

- Use **one `<Sequence>` per scene** with absolute `from`/`durationInFrames` from `timing.ts`. Inside a scene, drive sub-beats with `useCurrentFrame() - sequenceStart` and `spring()/interpolate()`.
- Transitions: use `@remotion/transitions` (`slide`/`fade`) at scene boundaries, ~`PUSH_MS`. Or a manual translate-X push.
- Audio: `<Audio src=track>` at root; SFX as short `<Audio>` clips inside their scenes' sequences so they move with re-timing.
- Render: `remotion render SuperNovaTeaser out/teaser.mp4 --codec h264`. Keep `Config.setVideoImageFormat("jpeg")`.

---

## 7. Production pitfalls (read before prompting Claude to build)

1. **Build scene-by-scene, then assemble.** Don't ask for the whole 30s at once — the model loses spatial/temporal coherence. Get Scene 1 (the trade) pixel-right first; it's 40% of the value.
2. **Parameterize or suffer.** Everything keys off `timing.ts`. When you nudge `DROP` to match your track, the whole flow should follow. If you find a magic number in a scene file, lift it to `timing.ts`.
3. **Spatial reasoning is weak.** Expect to correct z-index, overlap, and proportions by hand. State layer order explicitly in prompts ("QuoteCard above keyboard, below header").
4. **Springs, not linear fades** — name `SPRING_UI`/`SPRING_TAP` in every entrance prompt or you get lifeless slop.
5. **Two things moving max.** Per frame, limit simultaneous animation. Stagger (Scene 3 notifs especially).
6. **Numbers = tabular-nums + roll.** Cutting prices looks cheap; rolling them looks designed.
7. **Match real product copy** (§2 anchors). Inaccurate Telegram UI kills credibility with the target trader instantly.
8. **Music first, then sync.** Pick the track early, find the real drop frame, set `DROP`, then place the fill on it. Doing visuals first and forcing music later never lands.
9. **It's slow.** Realistically multiple sessions of frame-by-frame correction for 30 good seconds. Budget for it; the founder sets creative direction (this doc), the model executes pieces.

---

## 8. The 30s in one breath (for sanity-checks)

> Light ignites into SuperNova. A phone. `/long SOL` → tap $100 → tap 10× → a clean quote (margin, size, liq price) → **Confirm** → ⏳ → **✅ Filled, on-chain** *(drop)*. Flip to Guardian: trailing stop + breakeven toggle on, a shield arms, then *"stop moved to breakeven"* fires by itself. Alerts cascade — liquidation risk, price cross, a trader you follow goes long with a **Copy** button. Re-ignite. **@SuperNova_bot · Trade now.** Solana · Phoenix · Flight.

*One tap. On-chain. Auto-protected. That's the whole pitch.*
