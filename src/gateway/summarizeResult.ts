import { RESULT_SUMMARY_MAX_LENGTH } from "../constants.js";
import type { ToolCallResult } from "./UpstreamToolClient.js";

/** A short, human-readable line for audit_log.result_summary — deliberately never the
 *  full result payload (see DESIGN.md: audit logs should be readable without loading a
 *  huge context window, and shouldn't balloon storage with large tool outputs). */
export function summarizeResult(result: ToolCallResult): string {
  const text = result.content?.find((block) => block.type === "text")?.text ?? "";
  if (!text) return "(no text content)";
  return text.length > RESULT_SUMMARY_MAX_LENGTH ? `${text.slice(0, RESULT_SUMMARY_MAX_LENGTH)}…` : text;
}
