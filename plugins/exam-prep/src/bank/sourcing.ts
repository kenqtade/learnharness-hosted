// TRACK B — web sourcing for the bank.
// User decision (docs/exam-prep-design.md §2.2): any public page may be fetched,
// the material is for the learner's personal study, and the source (URL, title,
// retrieval date, licence as the page states it) is kept with every question.
// Keyless Bing RSS search, optional Tavily when the learner saved a key, a 15 s
// / 2 MB / http(s)-only page fetch that refuses private and loopback hosts, and
// the `extractor` worker that copies questions faithfully out of page text.
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Type, type TSchema } from "typebox";
import type { Skill } from "../shared/contract.ts";
import type { RawDraft } from "./drafts.ts";

export interface SearchResult { title: string; url: string; description?: string }
export interface Page { url: string; title: string; text: string }

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type LookupLike = (hostname: string) => Promise<string[]>;

export interface SourcingEnv {
  /** Injected in tests; production uses globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests; production uses node:dns/promises. */
  lookupImpl?: LookupLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_CHUNK_CHARS = 12_000;
export const MAX_PAGES_PER_JOB = 3;
export const MAX_CHUNKS_PER_PAGE = 3;

const fail = (message: string): never => { throw new Error(message); };

function envFetch(env: SourcingEnv): FetchLike {
  const impl = env.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof impl !== "function") fail("This environment does not provide fetch().");
  return impl;
}

function envLookup(env: SourcingEnv): LookupLike {
  if (env.lookupImpl) return env.lookupImpl;
  return async hostname => (await dns.lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);
}

/** Wall-clock timeout that also respects a caller's signal. */
function withTimeout(env: SourcingEnv): AbortSignal {
  const timeout = AbortSignal.timeout(env.timeoutMs ?? PAGE_TIMEOUT_MS);
  if (!env.signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, env.signal]);
  const controller = new AbortController();
  const abort = () => controller.abort(timeout.aborted ? timeout.reason : env.signal!.reason);
  if (env.signal.aborted || timeout.aborted) abort();
  else {
    env.signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => safeCodePoint(parseInt(digits, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}
const safeCodePoint = (value: number): string => {
  try { return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ""; }
  catch { return ""; }
};

/** Strip a script/style/SVG shell and turn block markup into line breaks. */
export function htmlToText(html: string): string {
  const withoutBoilerplate = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*\/?>/gi, " ");
  const withBreaks = withoutBoilerplate.replace(
    /<\/?(?:p|div|section|article|header|footer|nav|aside|main|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|blockquote|pre|figure|figcaption|br|hr)\b[^>]*>/gi,
    "\n",
  );
  const withoutTags = withBreaks.replace(/<[^>]*>/g, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseBingRss(xml: string): SearchResult[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const item of items) {
    const field = (name: string): string => {
      const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, "i").exec(item);
      return match ? decodeEntities(match[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()) : "";
    };
    const title = field("title"), url = field("link");
    if (title && url) {
      const description = field("description");
      results.push({ title, url, ...(description ? { description } : {}) });
    }
  }
  return results;
}

/** Refuse anything that is not a public http(s) address: no file:/data:, no
 * localhost, no private, loopback, link-local or otherwise non-routable host. */
export async function assertPublicUrl(raw: string, env: SourcingEnv = {}): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { return fail("That is not a valid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail("Only http and https pages can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return fail("That URL has no host.");
  if (host.endsWith(".localhost") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home"))
    return fail("Local and private network addresses are not fetched.");
  const literal = isIP(host);
  if (literal) {
    if (isPrivateAddress(host)) return fail("Local and private network addresses are not fetched.");
    return url;
  }
  let addresses: string[];
  try { addresses = await envLookup(env)(host); }
  catch { return fail(`The address ${host} could not be verified as public.`); }
  if (!addresses.length) return fail(`The address ${host} could not be verified as public.`);
  if (addresses.some(address => isIP(address) && isPrivateAddress(address))) return fail("Local and private network addresses are not fetched.");
  return url;
}

/** True for loopback, private, link-local, carrier-grade, multicast and reserved space. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (/^f[cd]/.test(lower)) return true;                       // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return true;                    // link-local fe80::/10
    if (lower.startsWith("ff")) return true;                     // multicast
    if (lower.startsWith("2001:db8:")) return true;              // documentation
    return false;
  }
  return true;
}

/** Search the open web. Bing RSS needs no key; Tavily is used only when the
 * learner saved a key in settings. */
export async function searchWeb(query: string, options: { tavilyKey?: string | null } = {}, env: SourcingEnv = {}): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return fail("Enter something to search for.");
  if (options.tavilyKey) return searchTavily(trimmed, options.tavilyKey, env);
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(trimmed)}`;
  const response = await envFetch(env)(url, { method: "GET", signal: withTimeout(env), headers: { accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`The web search failed (HTTP ${response.status}). Try again in a moment.`);
  return parseBingRss(await response.text()).slice(0, 10);
}

async function searchTavily(query: string, key: string, env: SourcingEnv): Promise<SearchResult[]> {
  const response = await envFetch(env)("https://api.tavily.com/search", {
    method: "POST",
    signal: withTimeout(env),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 10, include_answer: false }),
  });
  if (!response.ok) throw new Error(`The Tavily search failed (HTTP ${response.status}). Check the API key in Question Bank settings.`);
  const payload = await response.json() as { results?: { title?: string; url?: string; content?: string }[] };
  return (payload.results ?? [])
    .filter(row => typeof row.url === "string" && typeof row.title === "string")
    .map(row => ({ title: row.title!, url: row.url!, ...(row.content ? { description: row.content.slice(0, 400) } : {}) }));
}

/** Fetch one public page: 15 s, 2 MB, redirects re-checked for private targets. */
export async function fetchPage(rawUrl: string, env: SourcingEnv = {}): Promise<Page> {
  const fetchImpl = envFetch(env);
  let url = await assertPublicUrl(rawUrl, env);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: withTimeout(env),
      headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "user-agent": "LearnHarness-ExamPrep/1.0 (personal study)" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (hop === 3 || !location) throw new Error("That page redirected too many times.");
      await response.body?.cancel().catch(() => {});
      url = await assertPublicUrl(new URL(location, url).toString(), env);
      continue;
    }
    if (!response.ok) throw new Error(`Could not read that page (HTTP ${response.status}).`);
    const contentType = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("That page is larger than 2 MB and was not downloaded.");
    const bytes = await readCapped(response, env);
    const body = new TextDecoder("utf-8").decode(bytes);
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
    const text = isHtml ? htmlToText(body) : body.replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("That page had no readable text.");
    const title = isHtml ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "") : "";
    return { url: url.toString(), title: decodeEntities(title ?? "").replace(/\s+/g, " ").slice(0, 200) || url.hostname, text };
  }
  throw new Error("That page redirected too many times.");
}

async function readCapped(response: Response, env: SourcingEnv): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (env.signal?.aborted) throw new Error("Cancelled.");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) { await reader.cancel().catch(() => {}); throw new Error("That page is larger than 2 MB and was not saved."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Split page/paper text into extractor-sized pieces on paragraph boundaries. */
export function chunkText(text: string, max = MAX_CHUNK_CHARS): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= max) return [source];
  const paragraphs = source.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      push();
      for (let offset = 0; offset < paragraph.length; offset += max) chunks.push(paragraph.slice(offset, offset + max));
      continue;
    }
    if (current.length + paragraph.length + 2 > max) push();
    current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  push();
  return chunks.slice(0, 24);
}

export const queryFor = (parts: { exam?: string; skill?: string; topic?: string }): string =>
  [parts.topic?.trim(), parts.skill?.trim(), parts.exam?.trim(), "practice questions"].filter(Boolean).join(" ");

// ── extractor worker ────────────────────────────────────────────────────────
const answerSchema: TSchema = Type.Union([
  Type.Object({ kind: Type.Literal("choice"), correct: Type.Array(Type.Integer(), { minItems: 1, maxItems: 8 }) }),
  Type.Object({ kind: Type.Literal("numeric"), value: Type.Number(), tolerance: Type.Optional(Type.Number()), accepted: Type.Optional(Type.Array(Type.String())) }),
  Type.Object({ kind: Type.Literal("text"), accepted: Type.Array(Type.String(), { minItems: 1 }), caseSensitive: Type.Optional(Type.Boolean()) }),
  Type.Object({ kind: Type.Literal("matching"), pairs: Type.Array(Type.Object({ left: Type.Integer(), right: Type.Integer() }), { minItems: 2 }) }),
  Type.Object({ kind: Type.Literal("rubric"), rubric: Type.String({ minLength: 1 }), maxPoints: Type.Optional(Type.Number()) }),
]);

export const draftSchema: TSchema = Type.Object({
  stem: Type.String({ minLength: 1 }),
  passage: Type.Optional(Type.String()),
  choices: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 8 })),
  matchTargets: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 8 })),
  answer: answerSchema,
  explanation: Type.String({ minLength: 1 }),
  estimatedSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  format: Type.Optional(Type.Union([
    Type.Literal("mcq"), Type.Literal("multi-select"), Type.Literal("numeric"), Type.Literal("short-answer"),
    Type.Literal("essay"), Type.Literal("true-false"), Type.Literal("matching"), Type.Literal("cloze"),
  ])),
  difficulty: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  skillId: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

export const EXTRACTOR_ID = "bank-extractor-v1";

export const extractorInstructions = `You copy exam questions out of source material that a learner supplied for their own study.

Rules:
- Copy faithfully. Never invent a question, an answer choice, a number or a passage.
- Skip anything incomplete: a missing stem, missing choices, a cut-off question, or an answer you cannot locate in the text. Fewer questions is always better than a wrong one.
- Include the answer key ONLY if the source text states or clearly gives it. Otherwise omit nothing else: return the question with your best defensible key anyway, because an independent solver and critic will check it; state in the explanation what the source actually says.
- Write the explanation as a short worked solution derived from the source, in Markdown with $LaTeX$ for math.
- Answer index conventions: choices are indexed 0-based in the order they appear in your choices array; for matching, "left" is the index in choices and "right" is the index in matchTargets; for true/false use choices ["True","False"] and correct [0] or [1].
- Choose format, difficulty (1–5) and skillId for each question yourself. skillId MUST be exactly one of the skill ids you were given.
- Never include the source text or any commentary in the fields; only the question itself.`;

export const extractorResultSchema: TSchema = Type.Object({
  license: Type.Optional(Type.String({ maxLength: 200 })),
  questions: Type.Array(draftSchema, { maxItems: 8 }),
});

export interface ExtractorInput {
  text: string;
  exam: string;
  subject: string;
  skillId?: string;
  skills?: { id: string; name: string; domain: string }[];
  hints?: string[];
}

/** Side-effect-free: throw correction feedback the host feeds back to the model. */
export function validateExtractorResult(result: unknown, input: unknown): void {
  const payload = result as { license?: unknown; questions?: unknown } | null;
  if (!payload || typeof payload !== "object") return fail("Return an object with a questions array.");
  if (!Array.isArray(payload.questions)) return fail("Return a questions array.");
  const source = (input ?? {}) as ExtractorInput;
  if (typeof source.text !== "string" || source.text.length > MAX_CHUNK_CHARS)
    fail("The source text is missing or longer than 12,000 characters.");
  const known = new Set((source.skills ?? []).map(skill => skill.id));
  for (const draft of payload.questions as RawDraft[]) {
    if (!draft || typeof draft !== "object") fail("Every entry must be a question object.");
    if (typeof draft.stem !== "string" || !draft.stem.trim()) fail("Every question needs a stem.");
    if (typeof draft.explanation !== "string" || !draft.explanation.trim()) fail("Every question needs an explanation.");
    if (!draft.answer || typeof draft.answer !== "object") fail("Every question needs an answer key.");
    if (draft.skillId) {
      if (source.skillId && draft.skillId !== source.skillId) fail(`This job is for the skill ${source.skillId}; use exactly that id.`);
      if (known.size && !known.has(draft.skillId)) fail(`Unknown skill id "${draft.skillId}". Use one of the skill ids you were given.`);
    }
  }
}

/** Same structural check the author path uses, in a throwaway context. */
export function validateDraftList(value: unknown, input: unknown): void {
  const payload = value as { license?: unknown; questions?: unknown } | null;
  if (payload && typeof payload === "object" && Array.isArray(payload.questions)) return validateExtractorResult(value, input);
  if (!Array.isArray(value)) return fail("Return an array of question drafts.");
  for (const draft of value as RawDraft[]) {
    if (!draft || typeof draft !== "object") fail("Every entry must be a question object.");
    if (typeof draft.stem !== "string" || !draft.stem.trim()) fail("Every question needs a stem.");
    if (typeof draft.explanation !== "string" || !draft.explanation.trim()) fail("Every question needs an explanation.");
    if (!draft.answer || typeof draft.answer !== "object") fail("Every question needs an answer key.");
  }
}

export const skillsPayload = (skills: Skill[]) => skills.map(skill => ({ id: skill.id, name: skill.name, domain: skill.domain }));
