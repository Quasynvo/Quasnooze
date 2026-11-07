/**
 * vision.js — see the pixels, or say you cannot.
 *
 * Jan and OpenClaw send every screenshot to a multimodal API. We already
 * attach images to the user turn. The gap was honesty: a text-only 7B will
 * still "describe" a photo. This module is the gate: known vision tags pass,
 * everything else refuses before a token is spent inventing pixels.
 *
 * Mock provider is allowed through so tests that attach images keep testing
 * the attachment path, not this gate.
 */
const VISION_RE =
  /(?:llava|bakllava|moondream|minicpm-v|qwen2(?:\.5)?-vl|llama3\.2-vision|gemma3|pixtral|vision)/i;

export function isVisionModel(name) {
  return VISION_RE.test(String(name || ""));
}

export function visionDecision({ hasImages = false, model = "", provider = "ollama" } = {}) {
  if (!hasImages) return { ok: true, reason: "no-images" };
  if (provider === "mock") return { ok: true, reason: "mock" };
  if (isVisionModel(model)) return { ok: true, reason: "vision-tag" };
  return {
    ok: false,
    reason: "not-vision",
    message:
      `This turn has an image, but the active model (${model || "unset"}) is not a vision tag. ` +
      `Nothing was described, because that would be a guess. Pull a vision model ` +
      `(for example \`ollama pull llava\`) and \`/model llava\`, or drop the image.`,
  };
}
