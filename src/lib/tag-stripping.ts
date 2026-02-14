const MAX_TAG_COUNT = 100;

function countTags(content: string): number {
  const privateCount = (content.match(/<private>/g) || []).length;
  const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
  return privateCount + contextCount;
}

function stripTagsInternal(content: string): string {
  if (countTags(content) > MAX_TAG_COUNT) {
    return content
      .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, "")
      .replace(/<private>[\s\S]*?<\/private>/g, "")
      .trim();
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, "")
    .replace(/<private>[\s\S]*?<\/private>/g, "")
    .trim();
}

export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTagsInternal(content);
}

export function stripMemoryTagsFromJson(content: string): string {
  return stripTagsInternal(content);
}
