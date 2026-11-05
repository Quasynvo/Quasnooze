/** Optional local Whisper HTTP adapter. Deadlines include response body consumption. */
export const AUDIO_MAX_BYTES = 10_000_000;
export const WHISPER_TIMEOUT_MS = 5_000;
export const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/flac"]);

/**
 * How much of the previous chunk's transcript may condition the next request.
 * Whisper's `prompt` is decoder context, not a channel: the tail is what matters
 * for continuity, so the tail is what is sent. Bounded because an unbounded
 * "context" is a way to push arbitrary text through a transcription endpoint.
 */
export const PROMPT_MAX_CHARS = 400;

/** One line, no control characters, tail-first. Undefined when there is nothing to say. */
export function cleanPrompt(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(-PROMPT_MAX_CHARS) : "";
}

export async function transcribeAudio(bytes, mime, url, { prompt } = {}) {
  const signal = AbortSignal.timeout(WHISPER_TIMEOUT_MS);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), "voice." + ({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac" }[mime]));
  form.append("model", "whisper-1");
  // Streaming a long utterance in chunks loses the words that fell on a chunk
  // boundary; the previous chunk's text is what puts them back.
  const context = cleanPrompt(prompt);
  if (context) form.append("prompt", context);
  const response = await fetch(url, { method: "POST", body: form, signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Whisper returned HTTP ${response.status}; check WHISPER_URL and its server logs.`); }
  // Bound a malicious/misconfigured upstream response too.
  let text = "", count = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    count += chunk.byteLength;
    if (count > 1_000_000) throw new Error("Whisper response exceeded 1 MB.");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Whisper returned invalid JSON; check the transcription endpoint."); }
  if (typeof data.text !== "string") throw new Error("Whisper response has no text field; use an OpenAI-compatible transcription endpoint.");
  return data.text;
}

/** Doctor is not permission to contact an arbitrary destination from a file.
 * Only loopback origins are probed, at a fixed path, with no credentials, query,
 * or redirect following. Remote transcription remains an explicit runtime choice.
 * A response proves origin reachability, not endpoint/transcription readiness.
 */
export async function checkVoice(url) {
  if (!url) return ["skip", "voice: WHISPER_URL not configured — optional server transcription disabled; browser speech recognition is separate"];
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("use an http(s) URL");
    // Construct the destination from trusted literals, never forward the file's
    // URL/path/query. Numeric port conversion prevents file data becoming URL syntax.
    const hosts = { "localhost": "127.0.0.1", "127.0.0.1": "127.0.0.1", "[::1]": "[::1]" };
    if (!Object.hasOwn(hosts, parsed.hostname) || parsed.username || parsed.password) {
      return ["warn", "voice: Whisper configured; automatic probe skipped — doctor only contacts loopback HTTP origins without URL credentials. Verify remote endpoints explicitly."];
    }
    const host = parsed.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
    const protocol = parsed.protocol === "https:" ? "https:" : "http:";
    const port = parsed.port ? Number(parsed.port) : protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
    const destination = `${protocol}//${host}:${port}/`;
    const response = await fetch(destination, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.ok || response.status === 405) return ["ok", `voice: Whisper loopback HTTP origin reachable (HTTP ${response.status}); transcription not verified`];
    return ["warn", `voice: Whisper returned HTTP ${response.status} — check WHISPER_URL, authentication and server logs`];
  } catch {
    return ["warn", "voice: Whisper unreachable or timed out — check WHISPER_URL and start the transcription server"];
  }
}
