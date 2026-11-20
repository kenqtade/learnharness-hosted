// Hand-tuned built-in exam profiles (global starter set). Section ids and blueprint
// domains match src/shared/exams.ts so assembly finds bank questions by skill.
// Formats, timings and scales follow each exam's published format; where a board
// publishes no conversion table, the scale is a documented approximation.
import type { ExamProfile, ModuleSpec, QuestionFormat, SectionSpec, ToolId } from "../shared/contract.ts";
import { BUILT_IN_EXAMS } from "../shared/exams.ts";

const AT = "2026-11-20T00:00:00.000Z";
const even = (domains: string[]) => domains.map(domain => ({ domain, share: 1 / domains.length }));
const weighted = (pairs: [string, number][]) => pairs.map(([domain, share]) => ({ domain, share }));
const fmt = (pairs: [QuestionFormat, number][]) => pairs.map(([format, share]) => ({ format, share }));
const domainsOf = (exam: string, section: string) => BUILT_IN_EXAMS.find(e => e.id === exam)?.sections.find(s => s.id === section)?.domains ?? [];
const COMMON: ToolId[] = ["notes", "highlighter", "answer-eliminator"];

const SAT_MATH_SHEET = `**Reference** (as on the Digital SAT)

- Circle: $A = \\pi r^2$, $C = 2\\pi r$
- Rectangle: $A = \\ell w$ · Triangle: $A = \\tfrac12 bh$
- Pythagorean theorem: $c^2 = a^2 + b^2$
- Special right triangles: $x, x\\sqrt3, 2x$ (30°-60°-90°) and $s, s, s\\sqrt2$ (45°-45°-90°)
- Rectangular prism $V = \\ell wh$ · Cylinder $V = \\pi r^2 h$ · Sphere $V = \\tfrac43\\pi r^3$
- Cone $V = \\tfrac13 \\pi r^2 h$ · Pyramid $V = \\tfrac13 \\ell w h$
- A circle has $360°$ or $2\\pi$ radians; the angles of a triangle sum to $180°$.`;

const A_LEVEL_SHEET = `**Formulae** (selected, as in the A-Level formulae booklet)

- Binomial: $(a+b)^n = a^n + \\binom{n}{1}a^{n-1}b + \\binom{n}{2}a^{n-2}b^2 + \\dots + b^n$
- Arithmetic series: $S_n = \\tfrac12 n(2a + (n-1)d)$ · Geometric series: $S_n = \\dfrac{a(1-r^n)}{1-r}$, $S_\\infty = \\dfrac{a}{1-r}$
- $\\dfrac{d}{dx}\\tan kx = k\\sec^2 kx$ · $\\int \\tan kx\\,dx = \\tfrac1k \\ln|\\sec kx| + c$
- Integration by parts: $\\int u\\,\\dfrac{dv}{dx}dx = uv - \\int v\\,\\dfrac{du}{dx}dx$
- Trapezium rule: $\\int_a^b y\\,dx \\approx \\tfrac12 h\\{(y_0 + y_n) + 2(y_1 + \\dots + y_{n-1})\\}$
- $\\sin(A \\pm B) = \\sin A\\cos B \\pm \\cos A \\sin B$ · $\\cos(A \\pm B) = \\cos A\\cos B \\mp \\sin A \\sin B$
- Kinematics: $v = u + at$, $s = ut + \\tfrac12 at^2$, $v^2 = u^2 + 2as$, $s = \\tfrac12(u+v)t$
- Normal: $Z = \\dfrac{X - \\mu}{\\sigma}$ · Binomial $X \\sim B(n,p)$: $E(X) = np$, $\\operatorname{Var}(X) = np(1-p)$`;

const IB_SHEET = `**Formula booklet** (selected, Mathematics: analysis and approaches)

- $u_n = u_1 + (n-1)d$, $S_n = \\tfrac n2(2u_1 + (n-1)d)$ · $u_n = u_1 r^{n-1}$, $S_\\infty = \\dfrac{u_1}{1-r}$
- $\\log_a x = \\dfrac{\\log_b x}{\\log_b a}$ · $a^x = e^{x\\ln a}$
- Quadratic: $x = \\dfrac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$, $\\Delta = b^2 - 4ac$
- Sine rule $\\dfrac{a}{\\sin A} = \\dfrac{b}{\\sin B}$ · Cosine rule $c^2 = a^2 + b^2 - 2ab\\cos C$ · Area $\\tfrac12 ab\\sin C$
- Arc $l = r\\theta$, sector $A = \\tfrac12 r^2\\theta$
- Derivatives: $(\\sin x)' = \\cos x$, $(e^x)' = e^x$, $(\\ln x)' = \\tfrac1x$; chain, product and quotient rules
- Complex: $z = r(\\cos\\theta + i\\sin\\theta) = re^{i\\theta}$; De Moivre $z^n = r^n e^{in\\theta}$
- Binomial distribution $E(X) = np$, $\\operatorname{Var}(X) = np(1-p)$`;

function mod(id: string, name: string, questionCount: number, minutes: number, formats: ModuleSpec["formats"], blueprint: ModuleSpec["blueprint"], extra: Partial<ModuleSpec> = {}): ModuleSpec {
  return { id, name, questionCount, minutes, formats, ...(blueprint ? { blueprint } : {}), ...extra };
}
function section(id: string, name: string, subject: string, modules: ModuleSpec[], tools: ToolId[], extra: Partial<SectionSpec> = {}): SectionSpec {
  return { id, name, subject, modules, tools, ...extra };
}
const profile = (p: Omit<ExamProfile, "builtIn" | "revision" | "updatedAt">): ExamProfile => ({ ...p, builtIn: true, revision: 1, updatedAt: AT });

// ── Digital SAT ─────────────────────────────────────────────────────────────
const satRwBlueprint = weighted([["Craft and Structure", 0.28], ["Information and Ideas", 0.26], ["Standard English Conventions", 0.26], ["Expression of Ideas", 0.2]]);
const satMathBlueprint = weighted([["Algebra", 0.35], ["Advanced Math", 0.35], ["Problem-Solving and Data Analysis", 0.15], ["Geometry and Trigonometry", 0.15]]);
const SAT_CURVE: [number, number][] = [[0, 200], [0.1, 260], [0.3, 400], [0.5, 520], [0.7, 620], [0.85, 700], [0.95, 770], [1, 800]];
const sat = profile({
  id: "sat", name: "Digital SAT", country: "US", organization: "College Board", language: "en-US",
  description: "The adaptive Digital SAT: Reading and Writing, then Math, each in two modules. The second module is easier or harder depending on how you did in the first.",
  sections: [
    section("rw", "Reading and Writing", "Reading and Writing", [
      mod("m1", "Module 1", 27, 32, fmt([["mcq", 1]]), satRwBlueprint, { difficulty: [1, 2, 3, 4, 5] }),
      mod("m2", "Module 2", 27, 32, fmt([["mcq", 1]]), satRwBlueprint, { adaptive: { from: "m1", threshold: 0.6, easier: [1, 2, 3], harder: [3, 4, 5] } }),
    ], [...COMMON], { breakAfterMinutes: 10 }),
    section("math", "Math", "Math", [
      mod("m1", "Module 1", 22, 35, fmt([["mcq", 0.75], ["numeric", 0.25]]), satMathBlueprint, { difficulty: [1, 2, 3, 4, 5] }),
      mod("m2", "Module 2", 22, 35, fmt([["mcq", 0.75], ["numeric", 0.25]]), satMathBlueprint, { adaptive: { from: "m1", threshold: 0.6, easier: [1, 2, 3], harder: [3, 4, 5] } }),
    ], ["graphing-calculator", "reference-sheet", ...COMMON], { referenceSheet: SAT_MATH_SHEET }),
  ],
  scoring: { min: 400, max: 1600, step: 10, combine: "sum", label: "Total score", perSection: { rw: { min: 200, max: 800, curve: SAT_CURVE }, math: { min: 200, max: 800, curve: SAT_CURVE } } },
  rules: [
    "Two sections, two modules each: 27 Reading and Writing questions in 32 minutes per module, 22 Math questions in 35 minutes per module.",
    "Module 2 is routed: about 60% or more correct in module 1 sends you to the harder module, which is needed for the top scores.",
    "The built-in graphing calculator and the reference sheet are available for all of Math.",
    "You can flag questions, strike out choices and move freely within a module — but not back to a submitted module.",
    "10-minute break between the sections. Scores are 200–800 per section, 400–1600 in total (this simulation's conversion is an estimate).",
  ],
  sourceUrls: ["https://satsuite.collegeboard.org/digital/whats-on-the-test/structure"],
});

// ── ACT (enhanced, from 2025) ───────────────────────────────────────────────
const ACT_CURVE: [number, number][] = [[0, 1], [0.2, 10], [0.4, 16], [0.55, 20], [0.7, 24], [0.85, 30], [0.95, 34], [1, 36]];
const act = profile({
  id: "act", name: "ACT", country: "US", organization: "ACT, Inc.", language: "en-US",
  description: "The enhanced ACT: English, Math and Reading make up the composite (1–36); Science is optional and reported separately in the real test.",
  sections: [
    section("english", "English", "English", [mod("m1", "English", 50, 35, fmt([["mcq", 1]]), even(domainsOf("act", "english")))], [...COMMON]),
    section("math", "Mathematics", "Math", [mod("m1", "Mathematics", 45, 50, fmt([["mcq", 1]]), weighted([["Preparing for Higher Math", 0.6], ["Integrating Essential Skills", 0.3], ["Modeling", 0.1]]))], ["graphing-calculator", "scientific-calculator", ...COMMON], { breakAfterMinutes: 10 }),
    section("reading", "Reading", "Reading", [mod("m1", "Reading", 36, 40, fmt([["mcq", 1]]), even(domainsOf("act", "reading")))], [...COMMON]),
    section("science", "Science (optional)", "Science", [mod("m1", "Science", 40, 40, fmt([["mcq", 1]]), even(domainsOf("act", "science")))], [...COMMON]),
  ],
  scoring: { min: 1, max: 36, step: 1, combine: "average", label: "Composite", curve: ACT_CURVE },
  rules: ["English 50 questions/35 min, Math 45/50 min, Reading 36/40 min, optional Science 40/40 min.", "A permitted calculator may be used on Math only.", "There is no penalty for guessing — answer every question.", "Section scores are 1–36; the composite here averages the sections you take (the real composite uses English, Math and Reading)."],
  sourceUrls: ["https://www.act.org/content/act/en/products-and-services/the-act/test-preparation/enhanced-act.html"],
});

// ── IELTS Academic ──────────────────────────────────────────────────────────
const IELTS_READING: [number, number][] = [[0, 0], [0.1, 2.5], [0.25, 4], [0.33, 4.5], [0.4, 5], [0.5, 5.5], [0.6, 6], [0.7, 6.5], [0.78, 7], [0.85, 7.5], [0.9, 8], [0.95, 8.5], [1, 9]];
const ielts = profile({
  id: "ielts-academic", name: "IELTS Academic", country: "International", organization: "British Council / IDP / Cambridge", language: "en-GB",
  description: "IELTS Academic Reading (40 questions, 60 minutes) and Writing (Task 1 report + Task 2 essay, 60 minutes), with band scores 0–9.",
  sections: [
    section("listening", "Listening", "English", [], [], { notSimulated: "Listening needs recorded audio; it is not simulated here. Practise with official recordings." }),
    section("reading", "Reading", "English", [mod("m1", "Academic Reading", 40, 60, fmt([["true-false", 0.3], ["mcq", 0.25], ["short-answer", 0.2], ["matching", 0.15], ["cloze", 0.1]]), even(domainsOf("ielts-academic", "reading")))], ["highlighter", "notes"]),
    section("writing", "Writing", "English", [mod("m1", "Academic Writing", 2, 60, fmt([["essay", 1]]), weighted([["Task 1 Report", 0.5], ["Task 2 Essay", 0.5]]))], ["notes"]),
    section("speaking", "Speaking", "English", [], [], { notSimulated: "Speaking is a face-to-face interview; practise it with the tutor in a conversation." }),
  ],
  scoring: { min: 0, max: 9, step: 0.5, combine: "average", label: "Overall band", perSection: { reading: { min: 0, max: 9, curve: IELTS_READING }, writing: { min: 0, max: 9 } } },
  rules: ["Reading: three long passages, 40 questions, 60 minutes, no extra transfer time on computer.", "Writing: Task 1 (at least 150 words, ~20 min) and Task 2 (at least 250 words, ~40 min); Task 2 counts double in the real test.", "Spelling counts for short answers. True / False / Not Given questions test exactly what the passage states.", "Listening and Speaking are not simulated."],
  sourceUrls: ["https://ielts.org/take-a-test/test-types/ielts-academic-test"],
});

// ── A-Level Mathematics (Edexcel-style 9MA0) ────────────────────────────────
const A_BANDS = [{ min: 80, label: "A*" }, { min: 70, label: "A" }, { min: 60, label: "B" }, { min: 50, label: "C" }, { min: 40, label: "D" }, { min: 30, label: "E" }, { min: 0, label: "U" }];
const aLevel = profile({
  id: "a-level-maths", name: "A-Level Mathematics", country: "GB", organization: "Pearson Edexcel / AQA / OCR", language: "en-GB",
  description: "Three two-hour papers: Pure 1, Pure 2, and Statistics & Mechanics. Calculator allowed throughout; formulae booklet provided.",
  sections: [
    section("pure-1", "Paper 1: Pure Mathematics 1", "Math", [mod("m1", "Paper 1", 14, 120, fmt([["numeric", 0.6], ["short-answer", 0.4]]), even(domainsOf("a-level-maths", "pure-1")))], ["scientific-calculator", "reference-sheet", "notes"], { referenceSheet: A_LEVEL_SHEET }),
    section("pure-2", "Paper 2: Pure Mathematics 2", "Math", [mod("m1", "Paper 2", 14, 120, fmt([["numeric", 0.6], ["short-answer", 0.4]]), even(domainsOf("a-level-maths", "pure-2")))], ["scientific-calculator", "reference-sheet", "notes"], { referenceSheet: A_LEVEL_SHEET }),
    section("stats-mech", "Paper 3: Statistics and Mechanics", "Math", [mod("m1", "Paper 3", 14, 120, fmt([["numeric", 0.7], ["mcq", 0.3]]), weighted([["Statistics", 0.5], ["Mechanics", 0.5]]))], ["scientific-calculator", "reference-sheet", "notes"], { referenceSheet: A_LEVEL_SHEET }),
  ],
  scoring: { min: 0, max: 100, step: 1, combine: "average", label: "Percentage", bands: A_BANDS },
  rules: ["Each paper is 2 hours (100 marks in the real exam). Answer all questions.", "A scientific calculator is allowed; the formulae booklet is available from the tool bar.", "Grades use typical recent boundaries (A* ≈ 80%); real boundaries change every series."],
  sourceUrls: ["https://qualifications.pearson.com/en/qualifications/edexcel-a-levels/mathematics-2017.html"],
});

// ── IB Mathematics: Analysis and Approaches HL ──────────────────────────────
const IB_BANDS = [{ min: 75, label: "7" }, { min: 62, label: "6" }, { min: 50, label: "5" }, { min: 38, label: "4" }, { min: 27, label: "3" }, { min: 15, label: "2" }, { min: 0, label: "1" }];
const ib = profile({
  id: "ib-math-aa", name: "IB Mathematics: Analysis and Approaches (HL)", country: "International", organization: "International Baccalaureate", language: "en",
  description: "Paper 1 (no calculator), Paper 2 (graphing calculator) and the HL Paper 3 problem-solving paper. Final grade 1–7.",
  sections: [
    section("paper-1", "Paper 1 (no calculator)", "Math", [mod("m1", "Paper 1", 12, 120, fmt([["numeric", 0.6], ["short-answer", 0.4]]), even(domainsOf("ib-math-aa", "paper-1")))], ["reference-sheet", "notes"], { referenceSheet: IB_SHEET }),
    section("paper-2", "Paper 2 (calculator)", "Math", [mod("m1", "Paper 2", 12, 120, fmt([["numeric", 0.7], ["short-answer", 0.3]]), even(domainsOf("ib-math-aa", "paper-2")))], ["graphing-calculator", "reference-sheet", "notes"], { referenceSheet: IB_SHEET }),
    section("paper-3", "Paper 3 (HL problem solving)", "Math", [mod("m1", "Paper 3", 6, 60, fmt([["numeric", 0.6], ["short-answer", 0.4]]), even(domainsOf("ib-math-aa", "paper-3")))], ["graphing-calculator", "reference-sheet", "notes"], { referenceSheet: IB_SHEET }),
  ],
  scoring: { min: 0, max: 100, step: 1, combine: "average", label: "Percentage", bands: IB_BANDS },
  rules: ["Paper 1: no calculator. Papers 2 and 3: graphing calculator allowed.", "The formula booklet is available in every paper.", "Grade boundaries vary each session; this simulation uses typical values (7 ≈ 75%)."],
  sourceUrls: ["https://www.ibo.org/programmes/diploma-programme/curriculum/mathematics/"],
});

// ── Ethiopian ESSLCE (Grade 12 national exam) ───────────────────────────────
const ET_NOTE = "Question counts and times follow recent EAES papers; they can change from year to year.";
const etSection = (exam: string, id: string, name: string, subject: string, count: number, minutes: number) =>
  section(id, name, subject, [mod("m1", name, count, minutes, fmt([["mcq", 1]]), even(domainsOf(exam, id)))], ["answer-eliminator", "notes"]);
const ET_BANDS = [{ min: 50, label: "Pass (≥ 50%)" }, { min: 0, label: "Below pass mark" }];
const esslceNatural = profile({
  id: "et-esslce-natural", name: "Ethiopian ESSLCE — Natural Science", country: "ET", organization: "Educational Assessment and Examinations Service (EAES)", language: "en",
  description: "Grade 12 Ethiopian Secondary School Leaving Certificate Examination, natural-science stream. Multiple choice (A–D), no calculators.",
  sections: [
    etSection("et-esslce-natural", "english", "English", "English", 120, 150),
    etSection("et-esslce-natural", "math", "Mathematics (Natural Science)", "Math", 65, 180),
    etSection("et-esslce-natural", "physics", "Physics", "Physics", 50, 120),
    etSection("et-esslce-natural", "chemistry", "Chemistry", "Chemistry", 60, 120),
    etSection("et-esslce-natural", "biology", "Biology", "Biology", 100, 120),
    etSection("et-esslce-natural", "aptitude", "Scholastic Aptitude", "Aptitude", 60, 90),
  ],
  scoring: { min: 0, max: 600, step: 1, combine: "sum", label: "Total (out of 600)", perSection: Object.fromEntries(["english", "math", "physics", "chemistry", "biology", "aptitude"].map(id => [id, { min: 0, max: 100 }])), bands: [{ min: 300, label: "Pass (≥ 50%)" }, { min: 0, label: "Below pass mark" }] },
  rules: ["Every question is multiple choice with four options (A–D); there is no penalty for wrong answers.", "Calculators, phones and notes are not allowed.", "Each subject is scored out of 100.", ET_NOTE],
  sourceUrls: ["https://eaes.et/"],
});
const esslceSocial = profile({
  id: "et-esslce-social", name: "Ethiopian ESSLCE — Social Science", country: "ET", organization: "Educational Assessment and Examinations Service (EAES)", language: "en",
  description: "Grade 12 Ethiopian Secondary School Leaving Certificate Examination, social-science stream. Multiple choice (A–D), no calculators.",
  sections: [
    etSection("et-esslce-social", "english", "English", "English", 120, 150),
    etSection("et-esslce-social", "math", "Mathematics (Social Science)", "Math", 65, 180),
    etSection("et-esslce-social", "geography", "Geography", "Geography", 100, 120),
    etSection("et-esslce-social", "history", "History", "History", 100, 120),
    etSection("et-esslce-social", "economics", "Economics", "Economics", 80, 120),
    etSection("et-esslce-social", "aptitude", "Scholastic Aptitude", "Aptitude", 60, 90),
  ],
  scoring: { min: 0, max: 600, step: 1, combine: "sum", label: "Total (out of 600)", perSection: Object.fromEntries(["english", "math", "geography", "history", "economics", "aptitude"].map(id => [id, { min: 0, max: 100 }])), bands: [{ min: 300, label: "Pass (≥ 50%)" }, { min: 0, label: "Below pass mark" }] },
  rules: ["Every question is multiple choice with four options (A–D); there is no penalty for wrong answers.", "Calculators, phones and notes are not allowed.", "Each subject is scored out of 100.", ET_NOTE],
  sourceUrls: ["https://eaes.et/"],
});
void ET_BANDS;

export const BUILT_IN_PROFILES: readonly ExamProfile[] = [sat, act, ielts, aLevel, ib, esslceNatural, esslceSocial];

/** Structural check for saved / AI-built profiles. Throws learner-readable errors. */
export function assertProfile(value: unknown): asserts value is ExamProfile {
  const p = value as ExamProfile;
  if (!p || typeof p !== "object") throw new Error("A profile must be an object.");
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(p.id ?? "")) throw new Error("Profile id must be lowercase letters, digits and dashes.");
  if (!p.name?.trim()) throw new Error("The profile needs a name.");
  if (!Array.isArray(p.sections) || !p.sections.length) throw new Error("The profile needs at least one section.");
  const ids = new Set<string>();
  for (const s of p.sections) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id ?? "") || ids.has(s.id)) throw new Error(`Section ids must be unique slugs (problem: "${s.id}").`);
    ids.add(s.id);
    if (!s.name?.trim()) throw new Error("Every section needs a name.");
    if (!Array.isArray(s.modules) || !Array.isArray(s.tools)) throw new Error(`Section ${s.name} needs modules and tools lists.`);
    if (!s.modules.length && !s.notSimulated) throw new Error(`Section ${s.name} has no modules.`);
    for (const m of s.modules) {
      if (!m.id || !m.name) throw new Error(`A module in ${s.name} is missing its id or name.`);
      if (!Number.isInteger(m.questionCount) || m.questionCount < 1 || m.questionCount > 300) throw new Error(`${s.name} / ${m.name}: question count must be 1–300.`);
      if (!(m.minutes >= 0 && m.minutes <= 600)) throw new Error(`${s.name} / ${m.name}: minutes must be 0–600.`);
      if (!Array.isArray(m.formats) || !m.formats.length) throw new Error(`${s.name} / ${m.name}: give at least one question format.`);
    }
  }
  if (!p.scoring || !(p.scoring.max > p.scoring.min)) throw new Error("The score scale needs max > min.");
}
