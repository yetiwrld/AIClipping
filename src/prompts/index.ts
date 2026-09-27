/**
 * Prompt/template layer (spec §41). All AI prompts live here — main process
 * only. Every prompt demands strict JSON and constrains the model to
 * segment-id references so hallucinated timestamps are structurally
 * impossible (ADR-005).
 */

export interface NumberedSegment {
  id: number
  start: number
  end: number
  text: string
}

export interface DiscoveryPromptContext {
  segments: NumberedSegment[]
  durationPreset: 'short' | 'medium' | 'long' | 'mixed'
  minSeconds: number
  maxSeconds: number
  maxCandidates: number
  sourceTitle: string
  sourceDurationSeconds: number | null
}

export const DISCOVERY_SYSTEM = `You are a meticulous short-form video editor who finds the best standalone moments in long-form transcripts.

RULES YOU MUST FOLLOW:
1. The transcript may contain transcription errors. Reason about the intended meaning; do not quote it back blindly.
2. Express every clip range using transcript SEGMENT IDS: "startSegmentId" and "endSegmentId". Never output raw seconds.
3. Never invent dialogue. Your excerpt must be reconstructable from the referenced segments.
4. Clips must START at a meaningful opening (a hook, question, claim, or story start) and END after the payoff. Never start mid-thought or end on a dangling clause.
5. A clip must make sense to someone who has never seen the full video. Prioritize standalone value over cleverness.
6. Look at the ENTIRE transcript, not just the beginning. Spread candidates across the whole video.
7. Do not propose two clips covering the same moment.
8. Respect the requested duration window with reasonable tolerance (±35%).
9. Avoid moments that depend on unseen visuals, contain long dead air, or are mostly numbers read without context.

OUTPUT: Return ONLY valid JSON, no markdown fences, no commentary:
{"candidates":[{"startSegmentId":12,"endSegmentId":19,"title":"...","hook":"...","reason":"...","clipType":"story"}]}

- title: 4–9 words, specific, no clickbait clichés.
- hook: the opening line idea that stops the scroll (≤ 20 words).
- reason: 1–2 sentences explaining WHY this moment works standalone.
- clipType: one of strong-opinion|story|advice|surprising-fact|emotional-moment|debate|humor|transformation|lesson|question-answer|quote|other.`

export function buildDiscoveryUserPrompt(ctx: DiscoveryPromptContext): string {
  const lines = ctx.segments.map((s) => `${s.id} [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`)
  return `SOURCE: ${ctx.sourceTitle}${ctx.sourceDurationSeconds ? ` (${Math.round(ctx.sourceDurationSeconds / 60)} minutes)` : ''}
TARGET CLIP DURATION: ${ctx.minSeconds}–${ctx.maxSeconds} seconds (preset: ${ctx.durationPreset})
CANDIDATES TO RETURN: up to ${ctx.maxCandidates}

TRANSCRIPT (format: SEGMENT_ID [start–end seconds] text):
${lines.join('\n')}

Find up to ${ctx.maxCandidates} distinct, standalone moments. Return ONLY the JSON object.`
}

// ---------------------------------------------------------------- scoring --

export interface ScoringPromptContext {
  candidates: Array<{ index: number; title: string; excerpt: string; durationSeconds: number }>
}

export const SCORING_SYSTEM = `You audit short-form video clips for likely performance. You are producing an ESTIMATE, not a prediction — be honest and calibrated, never inflate.

Score each dimension 0–100 for the clip as a standalone vertical video:
- hook: does the first 2 seconds create immediate interest?
- contextCompleteness: understandable without the full source?
- clarity: is the message clear and articulate?
- retention: progression, tension, curiosity, or payoff that keeps viewers watching?
- emotionalImpact: does it provoke a reaction?
- standaloneValue: valuable on its own?
- shareability: would someone send this to a friend?
- visualSuitability: likely to work as a cropped vertical talking-head clip?

OUTPUT: Return ONLY valid JSON, no markdown fences:
{"scores":[{"candidateIndex":0,"hook":82,"contextCompleteness":90,"clarity":88,"retention":75,"emotionalImpact":60,"standaloneValue":85,"shareability":70,"visualSuitability":80,"explanation":"2–3 sentences: why this overall level, what is strong, what limits it."}]}`

export function buildScoringUserPrompt(ctx: ScoringPromptContext): string {
  const blocks = ctx.candidates
    .map(
      (c) =>
        `CANDIDATE ${c.index} — "${c.title}" (${c.durationSeconds.toFixed(0)}s)\n${c.excerpt.slice(0, 1400)}`
    )
    .join('\n\n---\n\n')
  return `Audit these candidate clips:\n\n${blocks}\n\nReturn ONLY the JSON object with one scores entry per candidate index.`
}

// --------------------------------------------------------------- metadata --

export interface MetadataPromptContext {
  clipTitle: string
  excerpt: string
  durationSeconds: number
  platform: string
  maxTitleLength: number
  hashtagCount: number
  descriptionFormat: 'short' | 'medium'
}

export const METADATA_SYSTEM = `You write platform-ready metadata for a short vertical video. You receive a clip transcript excerpt. Write like a professional social editor: specific, human, no emoji spam, no clickbait clichés, no "mind-blown" language.

OUTPUT: Return ONLY valid JSON, no markdown fences:
{"title":"...","description":"...","hashtags:["#tag1","#tag2"],"cta":"..."}

- title: specific and scannable, respect the length limit.
- description: 1–3 sentences (${'`short`'} ≈ 1 punchy sentence, ${'`medium`'} ≈ 2–3), optionally ending with the CTA idea.
- hashtags: lowercase, no spaces, ${'`#`'} prefix, the requested count.
- cta: ≤ 12 words prompting a follow/comment.`

export function buildMetadataUserPrompt(ctx: MetadataPromptContext): string {
  return `PLATFORM: ${ctx.platform} (title ≤ ${ctx.maxTitleLength} chars, ${ctx.hashtagCount} hashtags, ${ctx.descriptionFormat} description)
CLIP: "${ctx.clipTitle}" — ${ctx.durationSeconds.toFixed(0)} seconds

TRANSCRIPT EXCERPT:
${ctx.excerpt.slice(0, 1800)}

Return ONLY the JSON object.`
}
