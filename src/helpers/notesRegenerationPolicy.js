export function shouldRegenerateNotes({ enabled = true, enhancedContent, generatedHash, hashOf }) {
  if (enabled === false) {
    return { regenerate: false, reason: "disabled" };
  }
  if (!enhancedContent || enhancedContent.trim().length === 0) {
    return { regenerate: false, reason: "no-notes" };
  }
  if (!generatedHash) {
    return { regenerate: false, reason: "unknown-provenance" };
  }
  if (hashOf(enhancedContent) !== generatedHash) {
    return { regenerate: false, reason: "user-edited" };
  }
  return { regenerate: true, reason: "regenerate" };
}
