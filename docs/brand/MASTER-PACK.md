# Cosmic Sloth — proposed brand master pack

**Status:** maintainer-requested Pinch rebrand proposal, not a live rename. Working
recommendation: **Quasnooze** (`quasnooze`). Existing Pinch/lobster assets, default
routes, package identity and GitHub settings remain unchanged pending approval.

## 1. Five name candidates

| Kebab-case name | Character connection |
|---|---|
| **`quasnooze` — recommended** | Quasar + snooze: brilliant cosmic energy, delightfully unhurried body language. Short enough to say and remember. |
| `slothoryx` | Sloth + an invented constellation-like suffix: a strange little creature with a serious technical engine. |
| `orbitmellow` | Orbital motion + mellow: describes the relaxed, face-to-face companion experience without promising slowness. |
| `nebunuzzle` | Nebula + nuzzle: warmer, stranger, and more companion-like than “AI copilot.” |
| `glimmercrast` | Glimmer + procrastination: gently self-aware cosmic humor; deliberately a personality joke, not a performance policy. |

### Novelty screen — 2026-11-03

A combined exact-phrase web search returned no results for this five-name shortlist.
GitHub's public repository search (`GET /search/repositories?q=NAME+in:name`)
returned zero matches for each at the time checked. This is a preliminary naming
screen, **not proof of zero Google competition, uniqueness, ownership, available
domains/handles or trademark clearance**. Search coverage changes. Google itself,
registries, app stores, trademark registers and pronunciations across languages
were not independently checked. Do those checks before a final name or purchase.


## 2. Positioning, description and slogan

**Position:** a face-to-face, local-first Windows assistant with a luminous sloth
companion. It helps with real everyday tasks, not only coding. Calm delivery,
measured speed, transparent tool use and explicit consent are product principles.

**GitHub description proposal:**

> A local-first Windows assistant with a luminous cosmic sloth companion. Calm conversations, everyday help, and visible permissions—no hidden cloud detours.

**Primary slogan:** Cosmic calm. Local intelligence.

**Conversational line:** Bring the tangled idea. We’ll find the thread.

**Personality:** wise, warm, dryly funny, technically clear. One joke is enough.
“Urgent” never causes hibernation, intentional delays, refusal of useful help or
fake progress. No “ancient logic” accuracy/security claims. Small memory use and
speed are goals to measure, not promises an illustration can establish.

## 3. README header proposal

Do not replace the actual README or installation instructions until the brand is
approved and package/repository migration is separately planned.

```markdown
# Quasnooze ✧

> Cosmic calm. Local intelligence.

Meet your luminous little corner of the cosmos: a local-first Windows assistant
with the composure of a space sloth and none of the artificial waiting.
Bring a tangled idea, an everyday task, or a stubborn bug. We’ll find the thread.

## Core directives

1. **Calm is a personality—not a delay.** Respond promptly, show real progress,
   and say clearly when something cannot be done.
2. **Your orbit, your rules.** Microphone access is opt-in. Sensitive actions
   require visible approval. No animation grants permission.
3. **Starlight is decorative. Evidence isn’t.** Separate facts from guesses,
   cite sources when available, and never pretend a task ran when it didn’t.

Built on Pinch. Brand transition proposed; current installation and package names
remain unchanged until a reviewed migration is approved.
```

## 4. Visual identity

- **Character:** retain the user-supplied neon cyan sloth, large glasses,
  gelatinous/iridescent highlights and translucent tablet. Do not substitute a
  generic robot, new animal or lobster in the concept experience.
- **Palette:** void `#090D1B`, starlight `#F1F4FB`, plasma cyan `#83F5ED`,
  nebula violet `#BA9DFF`, secondary copy `#A7ADC4`.
- **Typography:** restrained system sans-serif; character supplies the eccentricity.
  No external font/CDN dependency.
- **Motif:** an independently drawn glasses-and-smile line mark, orbit traces,
  tiny star points. The mark is a proposal, not trademark clearance.
- **Motion:** slow buoyancy, limited pointer parallax, ambient orbit; quicker,
  purposeful UI transitions. Reduced-motion support stops decorative movement.
- **Accessibility:** labelled inputs and controls, visible keyboard focus, native
  settings dialog, text equivalents for avatar state, no flashing/strobing.

### Assets and provenance

- [Character WebP](../../public/brand/cosmic-sloth.webp): reframed/compressed from
  the image the maintainer supplied (`Gemini_Generated_Image_345h8y345h8y345h.png`).
- [Square avatar PNG](quasnooze-avatar.png): 512×512 reference-based crop.
- [Social banner JPG](quasnooze-social.jpg): 1200×630 reference-image composition
  with proposed wordmark, not a newly generated illustration.
- [Line mark SVG](../../public/brand/cosmic-mark.svg): original vector linework
  drawn for this proposal; not a replacement for the current public favicon.

The supplied image was identified as AI-generated. No independent rights,
exclusivity or training-data provenance audit was performed. Confirm permission
and provider terms before commercial use or organization-avatar upload. No claim
that the mascot is “absolutely unique” or that copyright/trademark is secured.

## 5. Social preview generation prompt

The provided composite is usable as a proposal now. For a later generative
render, attach the original reference under the filename `image_0.png` and use:

> Create ONE cinematic 1200×630 repository social banner. Use the character from
> image_0.png: the same luminous cyan gelatinous space sloth, distinctive oversized
> glasses, iridescent rim light and friendly wise face. Do not replace or redesign
> it as a robot or a different animal. Place the character on the right, floating
> face-forward in deep navy space with a translucent coding data-slate and subtle
> violet/cyan galaxy trails. Preserve clean negative space in the left 45 percent.
> Set the proposed repository name “quasnooze” there in a crisp futuristic but
> legible pale-starlight wordmark, with small supporting text “Cosmic calm. Local
> intelligence.” Keep the hierarchy restrained and premium, no glossy UI boxes,
> mock dashboards, collage or extra mascot. Soft nebula depth, very sparse stars,
> luminous details and generous breathing room. If lettering is imperfect,
> retain the empty left area and typeset the final wordmark as a separate layer.

## 6. Conversation experience

Open `/cosmic.html` in Pinch for the opt-in concept; use `?demo=1` for the
**explicitly labelled scripted preview**. `/` still opens the existing desktop
experience. No default page, repository name, avatar, package name or workflow
is switched by this proposal.

The illustration faces the user in a 2.5D stage. It is **not actual WebXR/headset
VR, a rigged 3D model, generated video or phoneme-accurate facial animation**.
The speaking mouth is a lightweight illustration overlay. Activity bars are
state indicators, not measured microphone amplitude or an audio waveform.

| State | Behavior and source of truth |
|---|---|
| Idle | Breathing motion; nothing implies microphone access. |
| Thinking | Glow/processing state for actual API work; text tokens never imply audio speech. |
| Listening | Actual reported Windows companion state, or clearly labelled simulated preview. |
| Speaking | Actual reported native speaking state, or explicitly simulated, silent animation. |
| Approval | Amber halo + real Allow/Deny controls; never voice-approved or auto-approved. |
| Attention | Visible real error or disconnected status; unknown native mic status stays unknown. |

Real text uses existing `/api/chat` SSE and `/api/approve` endpoints. Native voice
uses existing `/api/desktop` controls/state, which require the Windows companion.
This page never uses browser recognition/recording or cloud speech fallback. It
does not silently pick a new model/provider. The configured backend is displayed;
cloud providers remain governed by Pinch configuration, not falsely described as
local. Real conversations may be persisted by existing Pinch storage.

The instance key stays in tab memory and is removed from a supplied query URL
with `replaceState`; the page does not put it in web storage or share links.
Model output and approval text are rendered as text, not untrusted HTML. There is
no new token mechanism, automatic tool consent or general task cancellation.
“Stop voice” is only the native voice control, never a rollback promise. Losing
the connection can leave backend work running; the view explicitly says to check
Pinch. A pending web approval is denied best-effort on stream completion/failure.

### What remains before a full launch

Approve a name, finish name/rights clearance, validate native Windows speech and
actual user accessibility, test disconnect/reconnect and long-lived deployments,
and separately plan any repository/package/config migration. A real rigged,
lip-synced avatar would need additional character layers or a 3D model, local TTS
viseme/timing integration, performance budgets and accessibility validation. It
must not silently upload the user's voice to achieve the effect.
