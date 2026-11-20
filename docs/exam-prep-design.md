# Graph Lab + Exam Prep — design (branch `feat/core-plugins`)

Two new **core plugins** (shipped with the app, enabled in Settings → Plugins):

| Plugin | What the learner gets |
|---|---|
| **`graph-lab`** — Graph Lab | An interactive graphing calculator (Desmos-class) for every math topic, incl. complex numbers and matrices. A full screen of its own, live graphs inside tutor messages, and a calculator other plugins embed. |
| **`exam-prep`** — Exam Prep | **Question Bank**: carefully written, skill-linked, verified questions — authored by AI with independent checking, sourced from the web with the source saved, or imported from past papers. **Exam Simulator**: realistic timed simulations of official exams from any country, with exactly the tools that exam allows. |

Why one plugin for bank + simulator: the simulator builds every test from the bank and
plugins cannot read each other's data. They are two separate parts of one package with a
fixed contract between them (`src/shared/contract.ts`), so they are built in parallel.

---

## 1. Graph Lab (`plugins/graph-lab`)

**Engine** (`src/engine/`, framework-free TypeScript, math by `mathjs` — Apache-2.0):

| Mode | Features |
|---|---|
| **2D** | `y=f(x)`, `x=f(y)`, implicit `F(x,y)=0` (marching squares), inequalities (shaded), parametric `(x(t),y(t))`, polar `r=f(θ)`, points & tables, regressions (linear, quadratic, exponential) from table data, piecewise and domain restrictions `{x>0}` |
| **Sliders** | any free letter in an expression (`a`, `b`…) becomes a slider automatically (like Desmos); min/max/step; play animation |
| **Calculus** | derivative graph `f'(x)`, tangent line at a point, shaded definite integral with its value |
| **Points of interest** | click a curve: zeros, extrema, intersections, y-intercept; trace with a moving point |
| **Complex** | complex plane: plot complex numbers/vectors, arithmetic shown geometrically (add = vectors, multiply = rotate+scale), roots of unity / nth roots, **domain coloring** of `f(z)` (hue = argument, brightness = modulus), image of grid under `f(z)` (e.g. Möbius) |
| **Matrix** | 2×2 (and 3×3 projected) linear transformation: deformed grid, unit square → parallelogram with signed area = determinant, eigenvectors drawn, animated morph I → A; matrix calculator: det, inverse, transpose, product, RREF, eigenvalues (complex too), solve Ax=b |
| **3D** | `z=f(x,y)` surface mesh, parametric space curves; drag to rotate, zoom |
| **Calculator** | scientific keypad + expression evaluation (exact fractions where possible), degree/radian, history |

Interaction: pan (drag), zoom (wheel / pinch / buttons), reset view, keyboard focus,
expression list with colour + show/hide per row, errors shown per row, URL-free share as JSON.

**Integration**
- View **Graph Lab** (sidebar action): expression list + canvas + mode tabs; saved graphs (backend: `graphs.list/save/delete`).
- Code block ```` ```graph ```` in tutor messages → live interactive graph. Body = JSON
  `{"mode":"2d","expressions":["y=a x^2","y=2x+1"],"sliders":{"a":{"min":-3,"max":3,"value":1}},"view":{"x":[-5,5],"y":[-5,5]}}`
  or simply one expression per line. Tutor instructions (`registerInstructions`) teach the format.
- **Embeddable calculator**: `src/engine/calculator.ts` exports
  `mountCalculator(container, { kind: "graphing" | "scientific" | "four-function" | "matrix", features?, signal }) → { dispose() }`
  used by Exam Prep for exam tool palettes (e.g. SAT = graphing, Ethiopian national exam = none).

## 2. Exam Prep (`plugins/exam-prep`)

### 2.1 Data (backend, `ctx.dataDirectory`, through the hosted storage seam)
`bank.json` (questions, skills), `profiles.json` (custom/AI exam profiles), `attempts/<id>.json`
(one per exam sitting), `jobs.json` (AI authoring/sourcing jobs). All writes atomic, revisioned,
re-read on revision change (several serverless instances share them).

### 2.2 Question Bank (`src/bank/**`)
- **Question** (see contract): stem/passage in Markdown + LaTeX, format (multiple choice,
  multi-select, numeric grid-in, short answer, essay, true/false, matching, cloze), answer key
  with tolerance/alternatives, full explanation, **skill** (exam taxonomy domain → skill),
  difficulty 1–5, tools assumed, **source** (ai / web / upload / manual, with URL, title,
  license note, retrieved date), **verification** (status + each independent check).
- **AI authoring pipeline** (plugin workers, background, cheap model slot unless overridden):
  1. *author* writes N questions for an exam + skill + difficulty in that exam's official style;
  2. *solver* (fresh context, never sees the key) solves each;
  3. *critic* checks: exactly one defensible answer, matches official style/difficulty, no
     ambiguity, explanation correct. Agreement → `verified`; disagreement → `disputed` (kept
     out of exams until reviewed or regenerated).
- **Sourcing** (user choice 2026-11: any public page, personal study, source saved):
  search (keyless Bing RSS; optional Tavily/Brave key in settings) → fetch page →
  *extractor* worker copies questions faithfully with the URL → *solver* verifies the key.
  Each sourced question keeps `source.url`; the UI shows it.
- **Import**: upload a past paper (PDF/text) → `ctx.documents.toMarkdown` → extractor.
- **Bank view**: filter by exam/skill/difficulty/format/status/source; edit; delete; mastery
  per skill from attempts; "Practice this skill" quick sets.
- **Tutor tools** (`registerTools` for teacher/practice): `exam_bank_search`, `exam_bank_get`,
  `exam_results_recent` so lessons draw from verified bank questions instead of improvising.

### 2.3 Exam Simulator (`src/sim/**`)
- **Profiles** (built in, global starter set): Digital SAT, ACT, IELTS Academic (Reading,
  Writing; Listening/Speaking marked as not simulated), A-Level Mathematics, IB Mathematics
  AA, Ethiopian ESSLCE / national exam (Grade 12; natural & social streams). Each profile:
  sections → modules, question counts, minutes, format mix, skill taxonomy, **allowed tools
  per section** (graphing calculator, scientific, four-function, reference sheet, notes,
  highlighter, answer eliminator), breaks, adaptive rules, score scale.
- **AI profile builder**: any other exam worldwide → worker researches the official format
  (web) → proposes a profile → learner reviews/edits → saved.
- **Setup**: full test / one section / custom; strict (official tools & timing) or practice
  (extra time ×1.5/×2, untimed, extra tools); the AI may adjust tools for practice.
- **Assembly**: picks verified bank questions matching skill/difficulty blueprint; missing
  slots trigger the authoring pipeline first ("preparing your test" with progress).
- **Exam screen** (`ctx.ui.openSurface`, full page): section/module flow, countdown (hide/show,
  5-minute warning, auto-submit), question navigator, flag for review, answer eliminator,
  passage highlighter, scratch notes, tool palette exactly per section rules (graphing
  calculator = Graph Lab engine), breaks, adaptive module 2 (SAT-style routing).
  Answers saved continuously (reload/instance-safe).
- **Scoring & review**: scaled score per profile, section scores, per-skill breakdown, time per
  question, every question with the learner's answer, key, explanation and source; history of
  attempts; weak skills → "practice these" / tutor via `exam_results_recent`.

## 3. Build order (parallel, user choice)
| Track | Owner area |
|---|---|
| A | `plugins/graph-lab/**` |
| B | `plugins/exam-prep/src/bank/**` + its tests |
| C | `plugins/exam-prep/src/sim/**` + its tests |
`src/shared/**`, `src/main.ts`, `src/backend.ts`, build files: integration owner (not the tracks).

## 4. Hosted notes
- Data goes through the storage seam (Convex on hosted) automatically: plugin backends use
  plain `node:fs`. Workers are kept alive ≤ 240 s per task on hosted, so jobs are split into
  small tasks (≤ ~5 questions per worker task).
- Sourced questions are stored for the learner's own study with their source URL. The preview
  site is reachable by anyone with its link; keep that in mind before sharing it.
