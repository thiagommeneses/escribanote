// Bibliotecas da extensão usadas também no servidor: a ata, a busca e a página pública saem iguais.
export { normalize, effectiveEntries, participantNames, speakerName, toBlocks } from "../../extension/src/lib/transcript.js";
export { toText, mdToHtml, dateLabel, clock, PLATFORM } from "../../extension/src/lib/format.js";
export { ataRequest, chatRequest, reviewRequest, parseReview, templateFromPdfRequest, templateFromTextRequest, REVIEW_SCHEMA, QUICK_PROMPTS, chaptersRequest, parseChapters, CHAPTERS_MIN_MS } from "../../extension/src/lib/ai.js";
export { DEFAULT_TAGS } from "../../extension/src/lib/settings.js";
export { commitSummary, diffDocument, diffStats } from "../../extension/src/lib/diff.js";
