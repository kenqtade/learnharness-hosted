// Exam Prep — canonical ids for the built-in exams (integration owner).
// The bank's skill taxonomy (Skill.exam / Skill.domain) and the simulator's
// profiles (ExamProfile.id / SectionSpec.id / ModuleSpec.blueprint[].domain)
// MUST use exactly these strings so blueprints find matching questions.

export interface ExamCatalogEntry {
  id: string;
  name: string;
  country: string;
  organization: string;
  sections: { id: string; name: string; subject: string; domains: string[] }[];
}

export const BUILT_IN_EXAMS: readonly ExamCatalogEntry[] = [
  {
    id: "sat", name: "Digital SAT", country: "US", organization: "College Board",
    sections: [
      { id: "rw", name: "Reading and Writing", subject: "Reading and Writing", domains: ["Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions"] },
      { id: "math", name: "Math", subject: "Math", domains: ["Algebra", "Advanced Math", "Problem-Solving and Data Analysis", "Geometry and Trigonometry"] },
    ],
  },
  {
    id: "act", name: "ACT", country: "US", organization: "ACT, Inc.",
    sections: [
      { id: "english", name: "English", subject: "English", domains: ["Production of Writing", "Knowledge of Language", "Conventions of Standard English"] },
      { id: "math", name: "Mathematics", subject: "Math", domains: ["Preparing for Higher Math", "Integrating Essential Skills", "Modeling"] },
      { id: "reading", name: "Reading", subject: "Reading", domains: ["Key Ideas and Details", "Craft and Structure", "Integration of Knowledge and Ideas"] },
      { id: "science", name: "Science", subject: "Science", domains: ["Interpretation of Data", "Scientific Investigation", "Evaluation of Models, Inferences and Experimental Results"] },
    ],
  },
  {
    id: "ielts-academic", name: "IELTS Academic", country: "International", organization: "British Council / IDP / Cambridge",
    sections: [
      { id: "reading", name: "Reading", subject: "English", domains: ["Main Ideas", "Specific Detail", "Inference and Writer's View", "Vocabulary in Context"] },
      { id: "writing", name: "Writing", subject: "English", domains: ["Task 1 Report", "Task 2 Essay"] },
    ],
  },
  {
    id: "a-level-maths", name: "A-Level Mathematics", country: "GB", organization: "Pearson Edexcel / AQA / OCR",
    sections: [
      { id: "pure-1", name: "Pure Mathematics 1", subject: "Math", domains: ["Pure Mathematics"] },
      { id: "pure-2", name: "Pure Mathematics 2", subject: "Math", domains: ["Pure Mathematics"] },
      { id: "stats-mech", name: "Statistics and Mechanics", subject: "Math", domains: ["Statistics", "Mechanics"] },
    ],
  },
  {
    id: "ib-math-aa", name: "IB Mathematics: Analysis and Approaches (HL)", country: "International", organization: "International Baccalaureate",
    sections: [
      { id: "paper-1", name: "Paper 1 (no calculator)", subject: "Math", domains: ["Number and Algebra", "Functions", "Geometry and Trigonometry", "Statistics and Probability", "Calculus"] },
      { id: "paper-2", name: "Paper 2 (calculator)", subject: "Math", domains: ["Number and Algebra", "Functions", "Geometry and Trigonometry", "Statistics and Probability", "Calculus"] },
      { id: "paper-3", name: "Paper 3 (problem solving)", subject: "Math", domains: ["Functions", "Calculus", "Statistics and Probability"] },
    ],
  },
  {
    id: "et-esslce-natural", name: "Ethiopian ESSLCE — Natural Science", country: "ET", organization: "Educational Assessment and Examinations Service (EAES)",
    sections: [
      { id: "math", name: "Mathematics (Natural Science)", subject: "Math", domains: ["Algebra and Functions", "Calculus", "Geometry and Vectors", "Statistics and Probability"] },
      { id: "physics", name: "Physics", subject: "Physics", domains: ["Mechanics", "Heat and Thermodynamics", "Electricity and Magnetism", "Waves and Optics", "Modern Physics"] },
      { id: "chemistry", name: "Chemistry", subject: "Chemistry", domains: ["Atomic Structure and Bonding", "Physical Chemistry", "Inorganic Chemistry", "Organic Chemistry"] },
      { id: "biology", name: "Biology", subject: "Biology", domains: ["Cell Biology", "Genetics and Evolution", "Human Biology", "Ecology", "Plant Biology"] },
      { id: "english", name: "English", subject: "English", domains: ["Reading Comprehension", "Grammar", "Vocabulary", "Writing Skills"] },
      { id: "aptitude", name: "Scholastic Aptitude", subject: "Aptitude", domains: ["Verbal Reasoning", "Quantitative Reasoning"] },
    ],
  },
  {
    id: "et-esslce-social", name: "Ethiopian ESSLCE — Social Science", country: "ET", organization: "Educational Assessment and Examinations Service (EAES)",
    sections: [
      { id: "math", name: "Mathematics (Social Science)", subject: "Math", domains: ["Algebra and Functions", "Mathematics of Finance", "Statistics and Probability", "Linear Programming"] },
      { id: "geography", name: "Geography", subject: "Geography", domains: ["Physical Geography", "Human Geography", "Geography of Ethiopia and the Horn", "Map Reading"] },
      { id: "history", name: "History", subject: "History", domains: ["Ethiopian History", "African History", "World History"] },
      { id: "economics", name: "Economics", subject: "Economics", domains: ["Microeconomics", "Macroeconomics", "Ethiopian Economy"] },
      { id: "english", name: "English", subject: "English", domains: ["Reading Comprehension", "Grammar", "Vocabulary", "Writing Skills"] },
      { id: "aptitude", name: "Scholastic Aptitude", subject: "Aptitude", domains: ["Verbal Reasoning", "Quantitative Reasoning"] },
    ],
  },
];

/** "sat.math.algebra.linear-equations" style ids. */
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const skillId = (exam: string, section: string, domain: string, name: string) => [exam, section, slug(domain), slug(name)].join(".");
