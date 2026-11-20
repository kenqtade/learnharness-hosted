// TRACK B — Skill taxonomy for every built-in exam.
// Structure: exam id → section id → domain → skill names (3–8 concrete skills per
// domain). Ids are produced with skillId(exam, section, domain, name) from
// src/shared/exams.ts so the simulator's blueprint (which uses BUILT_IN_EXAMS
// domains) always finds skills — and therefore questions — for its slots.
// Official skill names are used where the exam body publishes them (Digital SAT,
// ACT); the Ethiopian ESSLCE skills follow the Grade 11–12 EAES curriculum.
import type { Skill } from "../shared/contract.ts";
import { BUILT_IN_EXAMS, skillId } from "../shared/exams.ts";

export type SkillTaxonomy = Record<string, Record<string, Record<string, readonly string[]>>>;

// Reused by both ESSLCE streams (the ids differ because the section id differs).
const ESSLCE_ENGLISH: Record<string, readonly string[]> = {
  "Reading Comprehension": [
    "Finding the main idea and supporting details",
    "Drawing inferences and interpretations",
    "Author's purpose, tone and attitude",
    "Sequencing and text structure",
  ],
  Grammar: [
    "Parts of speech and their functions",
    "Sentence structure: simple, compound and complex",
    "Subject–verb agreement",
    "Verb forms, tenses and sequence of tenses",
    "Clauses, phrases and conditionals",
  ],
  Vocabulary: [
    "Word formation with prefixes and suffixes",
    "Synonyms, antonyms and word pairs",
    "Meaning of words in context",
    "Commonly confused words",
  ],
  "Writing Skills": [
    "Paragraph organisation and cohesion",
    "Essay planning and structure",
    "Summary and note taking",
    "Formal register, accuracy and editing",
  ],
};

const ESSLCE_APTITUDE: Record<string, readonly string[]> = {
  "Verbal Reasoning": [
    "Verbal analogies",
    "Word classification and odd-one-out",
    "Logical conclusions from statements",
    "Sentence completion in context",
  ],
  "Quantitative Reasoning": [
    "Number series and patterns",
    "Quantitative word problems",
    "Ratio, proportion and percentage",
    "Averages and data comparison",
  ],
};

export const TAXONOMY: SkillTaxonomy = {
  sat: {
    rw: {
      "Information and Ideas": [
        "Central ideas and details",
        "Command of evidence: textual",
        "Command of evidence: quantitative",
        "Making inferences",
      ],
      "Craft and Structure": [
        "Words in context",
        "Text structure and purpose",
        "Cross-text connections",
      ],
      "Expression of Ideas": [
        "Rhetorical synthesis",
        "Transitions",
      ],
      "Standard English Conventions": [
        "Boundaries: sentences, fragments and run-ons",
        "Form, structure and sense",
        "Agreement: subjects, pronouns and parallelism",
        "Modifiers and pronoun reference",
        "Punctuation: commas, semicolons and dashes",
        "Apostrophes, possessives and plural forms",
      ],
    },
    math: {
      Algebra: [
        "Linear equations in one variable",
        "Linear functions",
        "Systems of two linear equations",
        "Linear inequalities",
      ],
      "Advanced Math": [
        "Equivalent expressions",
        "Nonlinear functions",
        "Nonlinear equations",
        "Polynomial graphs and equations",
      ],
      "Problem-Solving and Data Analysis": [
        "Ratios, rates and proportional relationships",
        "Percentages and percent change",
        "One-variable data: distributions and summaries",
        "Two-variable data: models and scatterplots",
        "Probability",
        "Evaluating statistical studies",
      ],
      "Geometry and Trigonometry": [
        "Area and volume",
        "Lines, angles and triangles",
        "Right triangles and trigonometry",
        "Circles",
      ],
    },
  },
  act: {
    english: {
      "Production of Writing": [
        "Topic sentences and transitions",
        "Unity and coherence",
        "Logical organisation of ideas",
      ],
      "Knowledge of Language": [
        "Style and tone",
        "Word choice and idiomatic usage",
        "Conciseness and redundancy",
      ],
      "Conventions of Standard English": [
        "Sentence structure and boundaries",
        "Verb tense and form",
        "Subject–verb agreement",
        "Pronoun case and reference",
        "Modifiers and parallelism",
        "Punctuation",
        "Capitalisation and spelling",
      ],
    },
    math: {
      "Preparing for Higher Math": [
        "Number and quantity: exponents, roots and ratios",
        "Solving equations and inequalities",
        "Functions: notation, domain and range",
        "Polynomials and systems of equations",
        "Coordinate geometry and lines",
        "Angles, triangles and circles",
        "Probability and counting",
        "Mean, median and data displays",
      ],
      "Integrating Essential Skills": [
        "Area and volume in context",
        "Percent change and proportional reasoning",
        "Averages and distributions in context",
        "Visual and spatial reasoning",
        "Multi-step word problems",
      ],
      Modeling: [
        "Building a model from a description",
        "Interpreting model outputs in context",
        "Choosing units and checking reasonableness",
      ],
    },
    reading: {
      "Key Ideas and Details": [
        "Main idea and primary purpose",
        "Supporting details and evidence",
        "Sequencing and relationships among ideas",
      ],
      "Craft and Structure": [
        "Meaning of words and phrases in context",
        "Text structure and organisation",
        "Author's voice, method and point of view",
      ],
      "Integration of Knowledge and Ideas": [
        "Summarising and comparing passages",
        "Analysing claims, evidence and reasoning",
        "Drawing inferences from the text",
        "Understanding rhetorical effect",
      ],
    },
    science: {
      "Interpretation of Data": [
        "Reading and comparing data tables",
        "Reading and interpreting graphs",
        "Calculating with experimental data",
      ],
      "Scientific Investigation": [
        "Identifying variables and controls",
        "Designing and evaluating experiments",
        "Predicting experimental results",
      ],
      "Evaluation of Models, Inferences and Experimental Results": [
        "Evaluating scientific models",
        "Drawing inferences from evidence",
        "Resolving conflicting results and conclusions",
      ],
    },
  },
  "ielts-academic": {
    reading: {
      "Main Ideas": [
        "Skimming for the overall meaning",
        "Identifying the writer's main claim",
        "Understanding paragraph purpose",
      ],
      "Specific Detail": [
        "Locating specific information",
        "Scanning for names, dates and figures",
        "Recognising paraphrase of the question",
      ],
      "Inference and Writer's View": [
        "Drawing inferences from the text",
        "Identifying opinion and attitude",
        "Recognising implication and hedging",
      ],
      "Vocabulary in Context": [
        "Inferring meaning from context",
        "Recognising paraphrase and synonymy",
        "Collocations and word families",
      ],
    },
    writing: {
      "Task 1 Report": [
        "Task achievement and the overview statement",
        "Describing visual data accurately",
        "Organising information logically",
        "Academic vocabulary and grammatical accuracy",
      ],
      "Task 2 Essay": [
        "Understanding the question type",
        "Positioning and developing an argument",
        "Coherence and cohesion across paragraphs",
        "Lexical range and grammatical control",
      ],
    },
  },
  "a-level-maths": {
    "pure-1": {
      "Pure Mathematics": [
        "Algebraic simplification and manipulation",
        "Solving equations: linear, quadratic and simultaneous",
        "Straight-line graphs and gradients",
        "Graphs and transformations",
        "Arithmetic sequences and series",
        "Trigonometry of the unit circle",
        "Exponentials, logarithms and laws of indices",
      ],
    },
    "pure-2": {
      "Pure Mathematics": [
        "Polynomial graphs and the factor theorem",
        "Binomial expansion",
        "Differentiation and stationary points",
        "Integration and area under a curve",
        "Trigonometric identities and equations",
        "Vectors in two and three dimensions",
        "Differential equations: separation of variables",
      ],
    },
    "stats-mech": {
      Statistics: [
        "Sets, probability and Venn diagrams",
        "Discrete random variables",
        "The normal distribution",
        "Sampling, estimation and correlation",
      ],
      Mechanics: [
        "Kinematics with calculus",
        "Forces, friction and Newton's laws",
        "Statics and equilibrium of a particle",
        "Momentum and impulse",
        "Work, energy and power",
      ],
    },
  },
  "ib-math-aa": {
    "paper-1": {
      "Number and Algebra": [
        "Sequences and series",
        "Exponents and logarithms",
        "Complex numbers",
        "The binomial theorem",
        "Counting, permutations and combinations",
      ],
      Functions: [
        "Function notation, domain and range",
        "Quadratic and reciprocal functions",
        "Composite, inverse and transformed functions",
        "Exponential and logarithmic functions",
      ],
      "Geometry and Trigonometry": [
        "Trigonometric ratios, identities and equations",
        "The sine and cosine rules",
        "Circles: arc length and sector area",
        "Vectors in two and three dimensions",
        "Equations of lines and planes",
      ],
      "Statistics and Probability": [
        "Descriptive statistics",
        "Probability: unions, intersections and conditioning",
        "Binomial and normal distributions",
        "Statistical inference and hypothesis testing",
      ],
      Calculus: [
        "Limits and continuity",
        "Differentiation rules and tangent lines",
        "Optimisation and related rates",
        "Integration and areas under curves",
        "Differential equations",
      ],
    },
    "paper-2": {
      "Number and Algebra": [
        "Sequences and series in context",
        "Exponents, logarithms and financial models",
        "Complex numbers",
        "The binomial theorem",
        "Counting, permutations and combinations",
      ],
      Functions: [
        "Function notation, domain and range",
        "Quadratic and reciprocal functions",
        "Composite, inverse and transformed functions",
        "Exponential and logarithmic models",
      ],
      "Geometry and Trigonometry": [
        "Trigonometric ratios, identities and equations",
        "The sine and cosine rules",
        "Geometry of 2D and 3D shapes",
        "Vectors in two and three dimensions",
        "Bearing, azimuth and 3D coordinate geometry",
      ],
      "Statistics and Probability": [
        "Descriptive statistics from data sets",
        "Probability in context",
        "Binomial and normal distributions",
        "Statistical inference and hypothesis testing",
      ],
      Calculus: [
        "Differentiation and rates of change",
        "Optimisation in context",
        "Integration and accumulation",
        "Differential equations and slope fields",
      ],
    },
    "paper-3": {
      Functions: [
        "Modelling with function families",
        "Inverse and composite functions in context",
        "Asymptotic behaviour",
      ],
      Calculus: [
        "L'Hôpital's rule and indeterminate forms",
        "Improper integrals",
        "Differential equation models and Euler's method",
        "Optimisation of a mathematical model",
      ],
      "Statistics and Probability": [
        "Expected value and variance of distributions",
        "Conditional probability and independence",
        "Modelling uncertainty in context",
      ],
    },
  },
  "et-esslce-natural": {
    math: {
      "Algebra and Functions": [
        "Sets, relations and functions",
        "Polynomials and factorisation",
        "Quadratic equations and inequalities",
        "Sequences and series",
        "Exponential and logarithmic functions",
      ],
      Calculus: [
        "Limits and continuity",
        "Differentiation and rules of differentiation",
        "Applications of derivatives: maxima, minima and curve sketching",
        "Integration and techniques of integration",
        "Applications of integration",
      ],
      "Geometry and Vectors": [
        "Plane geometry: triangles, quadrilaterals and circles",
        "Trigonometric ratios, identities and equations",
        "Vectors and vector operations",
        "Coordinate geometry of lines and conics",
      ],
      "Statistics and Probability": [
        "Measures of central tendency and dispersion",
        "Statistical diagrams and interpretation",
        "Counting principles, permutations and combinations",
        "Probability rules and events",
      ],
    },
    physics: {
      Mechanics: [
        "Kinematics: graphs and equations of motion",
        "Newton's laws of motion",
        "Work, energy and power",
        "Momentum and impulse",
        "Statics and equilibrium",
      ],
      "Heat and Thermodynamics": [
        "Temperature, heat and calorimetry",
        "Thermal expansion of solids and liquids",
        "Kinetic theory of an ideal gas",
        "Laws of thermodynamics and internal energy",
      ],
      "Electricity and Magnetism": [
        "Electric charge, field and potential",
        "Current, resistance and Ohm's law",
        "DC circuits and electrical power",
        "Magnetic fields and the force on a conductor",
        "Electromagnetic induction and transformers",
      ],
      "Waves and Optics": [
        "Simple harmonic motion",
        "Wave properties and the wave equation",
        "Reflection and refraction of light",
        "Thin lenses and optical instruments",
        "Interference and diffraction",
      ],
      "Modern Physics": [
        "The photoelectric effect and photons",
        "Bohr model of the atom and atomic spectra",
        "Radioactivity and nuclear reactions",
        "Mass–energy equivalence",
      ],
    },
    chemistry: {
      "Atomic Structure and Bonding": [
        "Subatomic particles, isotopes and atomic mass",
        "Electron configuration and orbitals",
        "Ionic, covalent and metallic bonding",
        "Molecular shape and polarity",
        "Intermolecular forces",
        "Periodic trends",
      ],
      "Physical Chemistry": [
        "Moles and stoichiometry",
        "States of matter and gas laws",
        "Chemical equilibrium",
        "Acids, bases and pH",
        "Thermochemistry and enthalpy change",
        "Reaction rates and activation energy",
      ],
      "Inorganic Chemistry": [
        "Periodic classification and group trends",
        "Chemistry of Group 1 and Group 2 elements",
        "Chemistry of the halogens",
        "Transition elements and their compounds",
      ],
      "Organic Chemistry": [
        "Organic nomenclature and functional groups",
        "Alkanes and alkenes",
        "Alcohols, aldehydes and ketones",
        "Carboxylic acids and esters",
        "Structural and stereochemical isomerism",
      ],
    },
    biology: {
      "Cell Biology": [
        "Cell structure and organelles",
        "Cell membrane transport",
        "Enzymes and metabolism",
        "Cell division: mitosis and meiosis",
      ],
      "Genetics and Evolution": [
        "Mendelian inheritance and genetic crosses",
        "DNA, genes and protein synthesis",
        "Mutation, variation and natural selection",
        "Population genetics and evidence for evolution",
      ],
      "Human Biology": [
        "Digestion and nutrition",
        "Transport: the heart, blood and circulation",
        "Respiration and gas exchange",
        "The nervous and endocrine systems",
        "Excretion and homeostasis",
      ],
      Ecology: [
        "Ecosystems, energy flow and food chains",
        "Nutrient cycles and biogeochemical cycles",
        "Population and community ecology",
        "Human impact on the environment",
      ],
      "Plant Biology": [
        "Plant transport: xylem and phloem",
        "Photosynthesis",
        "Respiration in plants",
        "Plant growth, tropisms and reproduction",
      ],
    },
    english: ESSLCE_ENGLISH,
    aptitude: ESSLCE_APTITUDE,
  },
  "et-esslce-social": {
    math: {
      "Algebra and Functions": [
        "Sets, relations and functions",
        "Polynomials and factorisation",
        "Quadratic equations and inequalities",
        "Sequences and series",
      ],
      "Mathematics of Finance": [
        "Simple and compound interest",
        "Depreciation and appreciation",
        "Profit, loss and discount",
        "Hire purchase and instalments",
      ],
      "Statistics and Probability": [
        "Measures of central tendency and dispersion",
        "Statistical diagrams and interpretation",
        "Counting principles and arrangements",
        "Basic probability of events",
      ],
      "Linear Programming": [
        "Formulating inequalities from a word problem",
        "Graphing constraints and the feasible region",
        "Objective functions and optimal solutions",
      ],
    },
    geography: {
      "Physical Geography": [
        "Landforms and geomorphic processes",
        "Weather and climate systems",
        "Rocks and geological processes",
        "Soils and natural vegetation",
      ],
      "Human Geography": [
        "Population and migration",
        "Urbanisation and settlement patterns",
        "Economic activities and land use",
        "Development and global connections",
      ],
      "Geography of Ethiopia and the Horn": [
        "Physical regions and landforms of Ethiopia",
        "Population and settlement in Ethiopia",
        "Natural resources and the environment of Ethiopia",
        "The Horn of Africa: states and regional patterns",
      ],
      "Map Reading": [
        "Map scale and distance",
        "Direction, bearings and grid references",
        "Contour interpretation and relief",
        "Map symbols and land-use interpretation",
      ],
    },
    history: {
      "Ethiopian History": [
        "Ancient and medieval Ethiopian states",
        "The Ethiopian Empire in the nineteenth century",
        "Italian occupation, resistance and restoration",
        "Ethiopia since 1960",
      ],
      "African History": [
        "Ancient African civilisations",
        "The partition of Africa and colonial rule",
        "Nationalism and the independence movements",
        "Africa since independence",
      ],
      "World History": [
        "Revolutions and the rise of nation-states",
        "Industrialisation and imperialism",
        "The First and Second World Wars",
        "The Cold War and the post-war order",
      ],
    },
    economics: {
      Microeconomics: [
        "Scarcity, choice and opportunity cost",
        "Demand and the law of demand",
        "Supply and market equilibrium",
        "Elasticity of demand and supply",
        "Production costs and revenue",
      ],
      Macroeconomics: [
        "National income and GDP measurement",
        "Inflation and the price level",
        "Unemployment",
        "Money, banking and interest rates",
        "Fiscal and monetary policy",
        "International trade and the balance of payments",
      ],
      "Ethiopian Economy": [
        "Structure and sectors of the Ethiopian economy",
        "Agriculture and rural development in Ethiopia",
        "Industrialisation, infrastructure and energy",
        "Development policy, trade and finance in Ethiopia",
      ],
    },
    english: ESSLCE_ENGLISH,
    aptitude: ESSLCE_APTITUDE,
  },
};

/**
 * One or two style notes for an exam, handed to the `author` worker so its output
 * reads like that exam's official questions.
 */
export const STYLE_NOTES: Record<string, readonly string[]> = {
  sat: [
    "Digital SAT style: short, direct stimulus (often 80–160 words); the four answer choices are parallel in length and grammar and exactly one is defensible.",
    "Word the question as the exam does: 'As used in line X, …', 'Which choice most effectively …', 'If 2x+3=…, what is the value of …?' Use $LaTeX$ for all math.",
  ],
  act: [
    "ACT style: passage-based or standalone items with four choices (A–D); the English section gives a short underlined/written-deleted passage, the Science section gives a figure or experiment description.",
    "Difficulty ramps from routine to multi-step; avoid trick wording and keep every distractor plausible for a student who made a real mistake.",
  ],
  "ielts-academic": [
    "IELTS style: authentic register and a realistic word limit; Reading items use the exam's own families (TRUE/FALSE/NOT GIVEN, YES/NO/NOT GIVEN, sentence completion, matching, multiple choice) with instructions stating the word limit.",
    "Writing tasks are assessed against the public band descriptors: the stem states the task, the input (chart/description) and the required format.",
  ],
  "a-level-maths": [
    "A-Level style (Pearson Edexcel/AQA/OCR): 'Show that…', 'Given that…', 'Find the exact value…'; full analytic working, not just an answer.",
    "State any method used (chain/product/quotient rule, substitution, Newton–Raphson) and use $LaTeX$ for exact forms such as $\sqrt{3}$ and $\tfrac{1}{2}$.",
  ],
  "ib-math-aa": [
    "IB style: command terms drive the stem ('Find', 'Show that', 'Hence deduce', 'Verify'), answers are exact unless the stem asks for 3 significant figures, and GDC use is stated when allowed.",
    "Award-style reasoning: the explanation must justify each step, including any theorem or identity used.",
  ],
  "et-esslce-natural": [
    "EAES ESSLCE style (Grades 11–12 Natural Science): concise, curriculum-based wording, four options with one correct answer; calculations show exact steps where partial credit matters.",
    "Mix conceptual recall with application (graphs, data, diagrams) and keep vocabulary at the level used in Ethiopian secondary textbooks.",
  ],
  "et-esslce-social": [
    "EAES ESSLCE style (Grades 11–12 Social Science): four-option items built on the Ethiopian curriculum, with locally grounded contexts (Ethiopia and the Horn) where the subject allows.",
    "Prefer questions a student could answer from the textbook plus reasoning, not from general knowledge alone.",
  ],
};

const requireSection = (exam: string, section: string) => {
  const profile = BUILT_IN_EXAMS.find(e => e.id === exam);
  if (!profile) throw new Error(`Unknown exam: ${exam}`);
  const entry = profile.sections.find(s => s.id === section);
  if (!entry) throw new Error(`Unknown section ${section} for exam ${exam}`);
  return entry;
};

/** Every built-in skill, deterministically ordered. */
export function buildSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const exam of Object.keys(TAXONOMY)) {
    for (const [section, domains] of Object.entries(TAXONOMY[exam]!)) {
      requireSection(exam, section);
      for (const [domain, names] of Object.entries(domains)) {
        for (const name of names) skills.push({ id: skillId(exam, section, domain, name), exam, domain, name });
      }
    }
  }
  return skills;
}

/** Merge the built-in taxonomy into a stored record: ids are fixed, so a stored
 * skill is never duplicated or overwritten; only missing ids are added. */
export interface SeedResult { skills: Record<string, Skill>; added: number }
export function mergeSkills(stored: Record<string, Skill>): SeedResult {
  const skills: Record<string, Skill> = { ...stored };
  let added = 0;
  for (const skill of buildSkills()) if (!skills[skill.id]) { skills[skill.id] = skill; added++; }
  return { skills, added };
}

/** Profile id → display name. */
export const examName = (exam: string) => BUILT_IN_EXAMS.find(e => e.id === exam)?.name ?? exam;
export const examIds = () => BUILT_IN_EXAMS.map(e => e.id);
export const subjectOf = (exam: string, section: string) => requireSection(exam, section).subject;
export const sectionName = (exam: string, section: string) => requireSection(exam, section).name;
export const styleNotesFor = (exam: string): readonly string[] => STYLE_NOTES[exam] ?? [];

/** Skills of one exam, ordered by section then domain (for the extractor's picker). */
export function skillsOf(exam: string, stored: Record<string, Skill>): Skill[] {
  return Object.values(stored).filter(s => s.exam === exam)
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/** "sat.math.algebra.linear-equations" → its exam and section (undefined when not a known exam section). */
export function parseSkillId(id: string): { exam: string; section: string; domain: string; name: string } | undefined {
  const [exam, section, domain, ...rest] = id.split(".");
  if (!exam || !section || !domain || !rest.length) return undefined;
  const entry = BUILT_IN_EXAMS.find(e => e.id === exam);
  if (entry && !entry.sections.some(s => s.id === section)) return undefined;
  return { exam, section, domain, name: rest.join(".") };
}

/** The subject (e.g. "Math") a skill belongs to; falls back to its section id for custom exams. */
export function subjectForSkill(exam: string, id: string): string {
  const parsed = parseSkillId(id);
  const entry = BUILT_IN_EXAMS.find(e => e.id === (parsed?.exam ?? exam));
  return entry?.sections.find(s => s.id === parsed?.section)?.subject ?? parsed?.section ?? "General";
}
