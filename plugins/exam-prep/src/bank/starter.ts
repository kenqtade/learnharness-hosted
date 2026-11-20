// A small starter set so the Question Bank and Exam Simulator work before any
// AI generation. Every item below was written for this app in the style of the
// exam (not copied from an official paper). source.kind "manual", verified.
import type { AnswerKey, Choice, Question, QuestionFormat } from "../shared/contract.ts";
import { slug } from "../shared/exams.ts";

const AT = "2026-11-20T00:00:00.000Z";
const SUBJECT: Record<string, string> = {
  "sat.rw": "Reading and Writing", "sat.math": "Math", "act.english": "English", "act.math": "Math", "act.reading": "Reading",
  "act.science": "Science", "ielts-academic.reading": "Reading", "ielts-academic.writing": "Writing",
  "a-level-maths.pure-1": "Math", "a-level-maths.pure-2": "Math", "a-level-maths.stats-mech": "Math",
  "ib-math-aa.paper-1": "Math", "ib-math-aa.paper-2": "Math", "ib-math-aa.paper-3": "Math",
  "et-esslce-natural.math": "Math", "et-esslce-natural.physics": "Physics", "et-esslce-natural.chemistry": "Chemistry",
  "et-esslce-natural.biology": "Biology", "et-esslce-natural.english": "English", "et-esslce-natural.aptitude": "Aptitude",
  "et-esslce-social.math": "Math", "et-esslce-social.geography": "Geography", "et-esslce-social.history": "History",
  "et-esslce-social.economics": "Economics", "et-esslce-social.english": "English", "et-esslce-social.aptitude": "Aptitude",
};

let counter = 0;
interface Spec {
  at: string;                 // "exam.section"
  domain: string;
  skill: string;              // slug of the skill name
  d: Question["difficulty"];
  stem: string;
  explanation: string;
  passage?: string;
  choices?: string[];         // A, B, C, … in order
  correct?: string | string[];
  numeric?: { value: number; accepted?: string[]; tolerance?: number };
  text?: string[];
  rubric?: { rubric: string; maxPoints: number };
  format?: QuestionFormat;
  tools?: Question["tools"];
  seconds?: number;
}
function q(spec: Spec): Question {
  const [exam, section] = spec.at.split(".") as [string, string];
  const choices: Choice[] | undefined = spec.choices?.map((text, i) => ({ id: String.fromCharCode(65 + i), text }));
  let answer: AnswerKey, format: QuestionFormat;
  if (spec.rubric) { answer = { kind: "rubric", ...spec.rubric }; format = "essay"; }
  else if (spec.numeric) { answer = { kind: "numeric", ...spec.numeric }; format = "numeric"; }
  else if (spec.text) { answer = { kind: "text", accepted: spec.text }; format = spec.format ?? "short-answer"; }
  else {
    const correct = Array.isArray(spec.correct) ? spec.correct : [spec.correct ?? "A"];
    answer = { kind: "choice", correct };
    format = spec.format ?? (correct.length > 1 ? "multi-select" : "mcq");
  }
  counter++;
  return {
    id: `starter_${String(counter).padStart(3, "0")}`, revision: 1, exams: [exam], subject: SUBJECT[spec.at] ?? section,
    skillId: `${exam}.${section}.${slug(spec.domain)}.${spec.skill}`, difficulty: spec.d, format,
    ...(spec.passage ? { passage: spec.passage } : {}), stem: spec.stem, ...(choices ? { choices } : {}), answer,
    explanation: spec.explanation, ...(spec.tools ? { tools: spec.tools } : {}), ...(spec.seconds ? { estimatedSeconds: spec.seconds } : {}),
    source: { kind: "manual", note: "Starter question written for LearnHarness Exam Prep." },
    verification: { status: "verified", checks: [{ by: "human", verdict: "agree", at: AT }] },
    tags: ["starter"], createdAt: AT, updatedAt: AT,
  };
}

export const STARTER_QUESTIONS: Question[] = [
  // ── Digital SAT · Math ──
  q({ at: "sat.math", domain: "Algebra", skill: "linear-equations-in-one-variable", d: 1, stem: "If $3x + 7 = 22$, what is the value of $x$?", choices: ["$3$", "$5$", "$7$", "$15$"], correct: "B", explanation: "Subtract 7 from both sides: $3x = 15$. Divide by 3: $x = 5$." }),
  q({ at: "sat.math", domain: "Algebra", skill: "systems-of-two-linear-equations", d: 3, stem: "$$\\begin{aligned} 2x + y &= 11 \\\\ x - y &= 1 \\end{aligned}$$ The solution to the system is $(x, y)$. What is the value of $xy$?", numeric: { value: 12 }, tools: ["graphing-calculator"], explanation: "Add the equations: $3x = 12$, so $x = 4$. Then $y = x - 1 = 3$, and $xy = 12$." }),
  q({ at: "sat.math", domain: "Algebra", skill: "linear-functions", d: 2, stem: "A plumber charges a fixed fee plus an hourly rate. A 2-hour job costs \\$150 and a 5-hour job costs \\$300. What is the fixed fee, in dollars?", numeric: { value: 50 }, explanation: "The rate is $(300-150)/(5-2) = 50$ dollars per hour. Fixed fee: $150 - 2(50) = 50$." }),
  q({ at: "sat.math", domain: "Advanced Math", skill: "nonlinear-equations", d: 3, stem: "What is the positive solution to $x^2 - 2x - 24 = 0$?", numeric: { value: 6 }, tools: ["graphing-calculator"], explanation: "Factor: $(x-6)(x+4) = 0$, so $x = 6$ or $x = -4$. The positive solution is $6$." }),
  q({ at: "sat.math", domain: "Advanced Math", skill: "equivalent-expressions", d: 2, stem: "Which expression is equivalent to $(2x - 3)^2$?", choices: ["$4x^2 - 9$", "$4x^2 - 6x + 9$", "$4x^2 - 12x + 9$", "$2x^2 - 12x + 9$"], correct: "C", explanation: "$(2x-3)^2 = 4x^2 - 2\\cdot 2x \\cdot 3 + 9 = 4x^2 - 12x + 9$." }),
  q({ at: "sat.math", domain: "Problem-Solving and Data Analysis", skill: "percentages-and-percent-change", d: 2, stem: "The price of a jacket rose from \\$80 to \\$92. By what percent did the price increase?", choices: ["$12\\%$", "$13\\%$", "$15\\%$", "$87\\%$"], correct: "C", explanation: "The increase is \\$12, and $12/80 = 0.15 = 15\\%$." }),
  q({ at: "sat.math", domain: "Problem-Solving and Data Analysis", skill: "probability", d: 2, stem: "A bag holds 4 red, 5 blue and 6 green marbles. One marble is drawn at random. What is the probability it is **not** green?", choices: ["$\\tfrac{2}{5}$", "$\\tfrac{3}{5}$", "$\\tfrac{1}{3}$", "$\\tfrac{9}{6}$"], correct: "B", explanation: "There are 15 marbles and 9 are not green: $9/15 = 3/5$." }),
  q({ at: "sat.math", domain: "Geometry and Trigonometry", skill: "right-triangles-and-trigonometry", d: 3, stem: "In right triangle $ABC$, angle $C$ is $90^\\circ$, $AC = 8$ and $BC = 15$. What is $\\sin A$?", choices: ["$\\tfrac{8}{17}$", "$\\tfrac{15}{17}$", "$\\tfrac{8}{15}$", "$\\tfrac{17}{15}$"], correct: "B", explanation: "The hypotenuse is $\\sqrt{8^2 + 15^2} = 17$. $\\sin A$ = opposite/hypotenuse $= BC/AB = 15/17$." }),
  q({ at: "sat.math", domain: "Geometry and Trigonometry", skill: "circles", d: 4, stem: "The equation $x^2 + y^2 - 6x + 8y = 0$ defines a circle in the $xy$-plane. What is the radius of the circle?", numeric: { value: 5 }, tools: ["graphing-calculator"], explanation: "Complete the squares: $(x-3)^2 + (y+4)^2 = 9 + 16 = 25$, so the radius is $5$." }),
  // ── Digital SAT · Reading and Writing ──
  q({ at: "sat.rw", domain: "Craft and Structure", skill: "words-in-context", d: 2, passage: "The new museum wing was designed to be ______: its glass walls let visitors see the sculpture garden from almost every gallery.", stem: "Which choice completes the text with the most logical and precise word?", choices: ["secluded", "transparent", "ornate", "temporary"], correct: "B", explanation: "The glass walls let visitors see outside, so the wing is *transparent*." }),
  q({ at: "sat.rw", domain: "Standard English Conventions", skill: "boundaries-sentences-fragments-and-run-ons", d: 3, passage: "Honeybees communicate the location of food through a \"waggle dance\" ______ the angle of the dance indicates the direction of the food relative to the sun.", stem: "Which choice completes the text so that it conforms to the conventions of Standard English?", choices: ["dance, the", "dance; the", "dance the", "dance, and, the"], correct: "B", explanation: "Two independent clauses must be joined properly; a semicolon does this. A comma alone creates a comma splice." }),
  q({ at: "sat.rw", domain: "Expression of Ideas", skill: "transitions", d: 2, passage: "Early solar panels converted less than 5 percent of sunlight into electricity. ______ many modern panels convert more than 20 percent.", stem: "Which choice completes the text with the most logical transition?", choices: ["Similarly,", "By contrast,", "For example,", "As a result,"], correct: "B", explanation: "The second sentence contrasts modern efficiency with early efficiency." }),
  // ── ACT ──
  q({ at: "act.math", domain: "Preparing for Higher Math", skill: "solving-equations-and-inequalities", d: 2, stem: "What is the solution set of $|x - 4| < 3$?", choices: ["$x < 7$", "$1 < x < 7$", "$x > 1$", "$-7 < x < 7$", "$x < 1$ or $x > 7$"], correct: "B", explanation: "$|x-4| < 3$ means $-3 < x - 4 < 3$, i.e. $1 < x < 7$." }),
  q({ at: "act.math", domain: "Integrating Essential Skills", skill: "averages-and-distributions-in-context", d: 2, stem: "Ana's first four test scores are 82, 90, 76 and 88. What score does she need on the fifth test for a mean of 85?", choices: ["85", "87", "88", "89", "90"], correct: "D", explanation: "She needs a total of $5 \\times 85 = 425$. She has $336$, so she needs $425 - 336 = 89$." }),
  q({ at: "act.english", domain: "Conventions of Standard English", skill: "subject-verb-agreement", d: 2, passage: "The collection of rare maps, which the library acquired last spring, **are** now on display in the main hall.", stem: "Which choice is best for the bold word?", choices: ["NO CHANGE", "is", "were", "have been"], correct: "B", explanation: "The subject is the singular *collection*, so the verb is *is*." }),
  q({ at: "act.science", domain: "Interpretation of Data", skill: "reading-and-comparing-data-tables", d: 2, passage: "| Temperature (°C) | Dissolved oxygen (mg/L) |\n|---|---|\n| 10 | 11.3 |\n| 20 | 9.1 |\n| 30 | 7.6 |\n| 40 | 6.4 |", stem: "Based on the table, as water temperature increases, the amount of dissolved oxygen:", choices: ["increases only.", "decreases only.", "increases, then decreases.", "stays the same."], correct: "B", explanation: "Each row with a higher temperature has a lower dissolved-oxygen value." }),
  q({ at: "act.reading", domain: "Key Ideas and Details", skill: "main-idea-and-primary-purpose", d: 2, passage: "For centuries, sailors relied on the stars to navigate. The invention of the marine chronometer in the eighteenth century changed this: by keeping accurate time at sea, it allowed navigators to calculate longitude precisely for the first time, making long voyages far safer.", stem: "The main purpose of the passage is to:", choices: ["describe how sailors read the stars.", "explain how an invention improved navigation.", "argue that long voyages were unnecessary.", "compare different kinds of clocks."], correct: "B", explanation: "The passage centres on the chronometer and how it made calculating longitude, and thus voyages, safer." }),
  // ── IELTS Academic ──
  q({ at: "ielts-academic.reading", domain: "Specific Detail", skill: "locating-specific-information", d: 2, format: "true-false", passage: "Urban beekeeping has grown rapidly in the past decade. In London alone, the number of registered hives more than doubled between 2008 and 2013. Some ecologists, however, warn that too many hives may leave too little nectar for wild bees.", stem: "Do the following statements agree with the information in the passage? *The number of registered hives in London more than doubled between 2008 and 2013.*", choices: ["True", "False", "Not Given"], correct: "A", explanation: "The passage states that hives 'more than doubled between 2008 and 2013' — True." }),
  q({ at: "ielts-academic.reading", domain: "Inference and Writer's View", skill: "identifying-opinion-and-attitude", d: 3, format: "true-false", passage: "Urban beekeeping has grown rapidly in the past decade. In London alone, the number of registered hives more than doubled between 2008 and 2013. Some ecologists, however, warn that too many hives may leave too little nectar for wild bees.", stem: "*All ecologists believe urban beekeeping harms wild bees.*", choices: ["True", "False", "Not Given"], correct: "B", explanation: "Only *some* ecologists warn of a risk, so the claim about *all* ecologists contradicts the passage — False." }),
  q({ at: "ielts-academic.reading", domain: "Specific Detail", skill: "scanning-for-names-dates-and-figures", d: 1, passage: "The Hubble Space Telescope was launched in 1990 and orbits Earth at an altitude of about 540 kilometres.", stem: "Complete the sentence with ONE NUMBER from the passage: Hubble orbits at an altitude of about ______ kilometres.", text: ["540"], explanation: "The passage gives the altitude as about 540 kilometres." }),
  q({ at: "ielts-academic.writing", domain: "Task 2 Essay", skill: "positioning-and-developing-an-argument", d: 3, stem: "**Task 2.** Some people believe that university education should be free for all students. Others think students should pay for their own studies. Discuss both views and give your own opinion. Write at least 250 words.", rubric: { rubric: "IELTS Task 2 band descriptors: Task Response (addresses both views, clear position throughout, developed ideas with examples); Coherence and Cohesion (logical paragraphing, cohesive devices); Lexical Resource (range and precision); Grammatical Range and Accuracy. Award a band 0–9 overall; under 250 words loses Task Response marks.", maxPoints: 9 }, explanation: "A strong answer presents arguments for free tuition (equal opportunity, public benefit) and for paying (cost to taxpayers, student commitment), then states and supports a clear opinion in a conclusion.", seconds: 2400 }),
  // ── A-Level Maths ──
  q({ at: "a-level-maths.pure-2", domain: "Pure Mathematics", skill: "differentiation-and-stationary-points", d: 3, stem: "The curve $y = x^3 - 6x^2 + 9x + 1$ has two stationary points. Find the $x$-coordinate of the local **minimum**.", numeric: { value: 3 }, tools: ["scientific-calculator"], explanation: "$y' = 3x^2 - 12x + 9 = 3(x-1)(x-3)$, so stationary points at $x = 1, 3$. $y'' = 6x - 12$ is positive at $x = 3$, so the minimum is at $x = 3$." }),
  q({ at: "a-level-maths.pure-2", domain: "Pure Mathematics", skill: "integration-and-area-under-a-curve", d: 3, stem: "Evaluate $\\displaystyle\\int_0^2 (3x^2 + 2x)\\,dx$.", numeric: { value: 12 }, explanation: "$\\left[x^3 + x^2\\right]_0^2 = 8 + 4 = 12$." }),
  q({ at: "a-level-maths.stats-mech", domain: "Mechanics", skill: "forces-friction-and-newton-s-laws", d: 3, stem: "A box of mass $5\\,\\text{kg}$ is pulled along rough horizontal ground by a horizontal force of $30\\,\\text{N}$. The friction force is $10\\,\\text{N}$. Find the acceleration of the box in $\\text{m s}^{-2}$.", numeric: { value: 4 }, explanation: "Resultant force $= 30 - 10 = 20\\,\\text{N}$. $a = F/m = 20/5 = 4\\,\\text{m s}^{-2}$." }),
  // ── IB Math AA ──
  q({ at: "ib-math-aa.paper-1", domain: "Number and Algebra", skill: "exponents-and-logarithms", d: 2, stem: "Solve $\\log_2(x + 3) = 4$ (no calculator).", numeric: { value: 13 }, explanation: "$x + 3 = 2^4 = 16$, so $x = 13$." }),
  q({ at: "ib-math-aa.paper-1", domain: "Number and Algebra", skill: "sequences-and-series", d: 3, stem: "The first term of a geometric series is $8$ and the common ratio is $\\tfrac{1}{2}$. Find the sum to infinity.", numeric: { value: 16 }, explanation: "$S_\\infty = \\dfrac{u_1}{1 - r} = \\dfrac{8}{1/2} = 16$." }),
  q({ at: "ib-math-aa.paper-2", domain: "Calculus", skill: "optimisation-in-context", d: 4, stem: "A rectangle has perimeter $40\\,\\text{cm}$. Find the maximum possible area, in $\\text{cm}^2$.", numeric: { value: 100 }, tools: ["graphing-calculator"], explanation: "With sides $x$ and $20 - x$, $A = x(20-x)$. $A' = 20 - 2x = 0$ gives $x = 10$, so the maximum area is $100\\,\\text{cm}^2$ (a square)." }),
  // ── Ethiopian ESSLCE · Natural science ──
  q({ at: "et-esslce-natural.math", domain: "Calculus", skill: "limits-and-continuity", d: 2, stem: "Evaluate $\\displaystyle\\lim_{x \\to 3} \\frac{x^2 - 9}{x - 3}$.", choices: ["$0$", "$3$", "$6$", "$9$"], correct: "C", explanation: "$\\dfrac{x^2-9}{x-3} = x + 3$ for $x \\ne 3$, so the limit is $6$." }),
  q({ at: "et-esslce-natural.math", domain: "Algebra and Functions", skill: "exponential-and-logarithmic-functions", d: 2, stem: "If $\\log_{10} 2 \\approx 0.301$, then $\\log_{10} 8 \\approx$", choices: ["$0.602$", "$0.903$", "$2.408$", "$0.100$"], correct: "B", explanation: "$\\log 8 = \\log 2^3 = 3\\log 2 \\approx 0.903$." }),
  q({ at: "et-esslce-natural.physics", domain: "Mechanics", skill: "kinematics-graphs-and-equations-of-motion", d: 2, stem: "A car starts from rest and accelerates uniformly at $2\\,\\text{m/s}^2$ for $5\\,\\text{s}$. How far does it travel?", choices: ["$10\\,\\text{m}$", "$20\\,\\text{m}$", "$25\\,\\text{m}$", "$50\\,\\text{m}$"], correct: "C", explanation: "$s = ut + \\tfrac12 at^2 = 0 + \\tfrac12(2)(5^2) = 25\\,\\text{m}$." }),
  q({ at: "et-esslce-natural.physics", domain: "Electricity and Magnetism", skill: "current-resistance-and-ohm-s-law", d: 2, stem: "Two resistors of $6\\,\\Omega$ and $3\\,\\Omega$ are connected in parallel. What is their equivalent resistance?", choices: ["$9\\,\\Omega$", "$4.5\\,\\Omega$", "$2\\,\\Omega$", "$0.5\\,\\Omega$"], correct: "C", explanation: "$\\dfrac{1}{R} = \\dfrac16 + \\dfrac13 = \\dfrac12$, so $R = 2\\,\\Omega$." }),
  q({ at: "et-esslce-natural.chemistry", domain: "Physical Chemistry", skill: "moles-and-stoichiometry", d: 2, stem: "How many moles of water are produced when 4 moles of hydrogen gas react completely with excess oxygen? ($2\\text{H}_2 + \\text{O}_2 \\rightarrow 2\\text{H}_2\\text{O}$)", choices: ["2", "4", "6", "8"], correct: "B", explanation: "The mole ratio H₂ : H₂O is 2 : 2 = 1 : 1, so 4 mol H₂ gives 4 mol H₂O." }),
  q({ at: "et-esslce-natural.chemistry", domain: "Physical Chemistry", skill: "acids-bases-and-ph", d: 3, stem: "What is the pH of a $0.001\\,\\text{M}$ HCl solution?", choices: ["1", "2", "3", "11"], correct: "C", explanation: "HCl is a strong acid: $[\\text{H}^+] = 10^{-3}$ M, so pH $= 3$." }),
  q({ at: "et-esslce-natural.biology", domain: "Cell Biology", skill: "cell-structure-and-organelles", d: 1, stem: "Which organelle is the main site of aerobic respiration in a eukaryotic cell?", choices: ["Ribosome", "Mitochondrion", "Golgi apparatus", "Nucleus"], correct: "B", explanation: "The Krebs cycle and oxidative phosphorylation take place in the mitochondrion." }),
  q({ at: "et-esslce-natural.biology", domain: "Genetics and Evolution", skill: "mendelian-inheritance-and-genetic-crosses", d: 3, stem: "Two heterozygous tall pea plants ($Tt \\times Tt$) are crossed. What fraction of the offspring is expected to be short ($tt$)?", choices: ["$\\tfrac14$", "$\\tfrac12$", "$\\tfrac34$", "$0$"], correct: "A", explanation: "The Punnett square gives $TT : Tt : tt = 1 : 2 : 1$, so $\\tfrac14$ are $tt$." }),
  q({ at: "et-esslce-natural.english", domain: "Grammar", skill: "verb-forms-tenses-and-sequence-of-tenses", d: 2, stem: "By the time we arrived at the station, the train ______.", choices: ["leaves", "has left", "had left", "will leave"], correct: "C", explanation: "An action completed before another past action uses the past perfect: *had left*." }),
  q({ at: "et-esslce-natural.aptitude", domain: "Quantitative Reasoning", skill: "number-series-and-patterns", d: 2, stem: "What is the next number in the series $2, 6, 12, 20, 30, \\ldots$?", choices: ["36", "40", "42", "48"], correct: "C", explanation: "The differences are 4, 6, 8, 10, so the next difference is 12: $30 + 12 = 42$." }),
  // ── Ethiopian ESSLCE · Social science ──
  q({ at: "et-esslce-social.math", domain: "Mathematics of Finance", skill: "simple-and-compound-interest", d: 2, stem: "Birr 5,000 is deposited at 10% simple interest per year. What is the total amount after 3 years?", choices: ["Birr 5,500", "Birr 6,000", "Birr 6,500", "Birr 6,655"], correct: "C", explanation: "Interest $= 5000 \\times 0.10 \\times 3 = 1500$, so the amount is Birr 6,500." }),
  q({ at: "et-esslce-social.geography", domain: "Map Reading", skill: "map-scale-and-distance", d: 2, stem: "On a map with a scale of 1 : 50,000, two towns are 6 cm apart. What is the actual distance between them?", choices: ["0.3 km", "3 km", "30 km", "300 km"], correct: "B", explanation: "$6 \\times 50{,}000 = 300{,}000$ cm $= 3$ km." }),
  q({ at: "et-esslce-social.history", domain: "Ethiopian History", skill: "the-ethiopian-empire-in-the-nineteenth-century", d: 2, stem: "The Battle of Adwa, in which Ethiopian forces defeated the Italian army, took place in:", choices: ["1868", "1889", "1896", "1935"], correct: "C", explanation: "The Battle of Adwa was fought on 1 March 1896 under Emperor Menelik II." }),
  q({ at: "et-esslce-social.economics", domain: "Microeconomics", skill: "demand-and-the-law-of-demand", d: 1, stem: "According to the law of demand, other things being equal, when the price of a good rises:", choices: ["quantity demanded rises", "quantity demanded falls", "supply falls", "demand curve shifts right"], correct: "B", explanation: "The law of demand states an inverse relationship between price and quantity demanded." }),
];
