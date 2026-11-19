import type { CapabilityTag } from '../types'

export function inferTags(modelId: string, extra: { contextLength?: number; vision?: boolean; media?: boolean } = {}): CapabilityTag[] {
  const idl = modelId.toLowerCase()
  const tags = new Set<CapabilityTag>(['general'])
  if (/coder|code|devstral|codestral|swe|qwen3-coder|kimi-k2|glm-4\.[5-9]|glm-[5-9]/.test(idl)) tags.add('code')
  if (/flash|lite|mini|small|nano|haiku|8b|7b|3b|1b|fast|instant|turbo/.test(idl)) tags.add('fast')
  if (/r1|reason|think|o3|o4|qwq|pro|deepseek-v3\.[1-9]/.test(idl)) tags.add('reasoning')
  if (/vision|vl|gemini|gpt-4o|llama-4|pixtral|gemma-3/.test(idl) || extra.vision) tags.add('vision')
  if ((extra.contextLength ?? 0) >= 128_000 || /gemini/.test(idl)) tags.add('long-context')
  if (extra.media || /image|tts|lyria|music|audio/.test(idl)) tags.add('media')
  return [...tags]
}
