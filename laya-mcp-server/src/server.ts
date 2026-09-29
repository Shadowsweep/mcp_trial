import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bootstrap, decideChoice, decideAll, scoreSeverity, gateBoolean, sanitize, cacheStats } from "./engine.ts";

const server = new McpServer({ name: "laya-decision-engine", version: "0.1.0" });

server.tool(
  "decide_choice",
  {
    context_state: z.string(),
    question: z.string(),
    options: z.array(z.string()),
    // ponytail: real-model confidence is 1-normalized-entropy (~0.4-0.7 for good answers), not max-prob
    min_confidence: z.number().optional().default(0.4),
  },
  async ({ context_state, question, options, min_confidence }) => {
    const clean = sanitize(context_state);
    if (!clean) return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "context_state empty" }) }], isError: true };
    if (!options || options.length < 2) return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "options need >=2" }) }], isError: true };
    if (options.length > 20) return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "max 20 options, group hierarchically" }) }], isError: true };
    try {
      const r = await decideChoice(clean, question, options.map(sanitize));
      const esc = r.confidence < min_confidence;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            isError: false, selected_option: r.selected, confidence: r.confidence,
            needs_human_escalation: esc,
            confidence_verdict: esc ? "LOW_CONFIDENCE_REVIEW_NEEDED" : "HIGH_CONFIDENCE",
            distribution: r.distribution, degraded_mode: r.degraded_mode, truncated: r.truncated,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: String(e?.message || e) }) }], isError: true };
    }
  }
);

server.tool(
  "score_severity",
  { context_state: z.string(), rubric_dimension: z.string().optional().default("urgency"), scale_max: z.number().optional().default(3) },
  async ({ context_state, scale_max }) => {
    if (!sanitize(context_state)) return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "context_state empty" }) }], isError: true };
    const r = await scoreSeverity(context_state, scale_max);
    return { content: [{ type: "text", text: JSON.stringify({ isError: false, ...r }, null, 2) }] };
  }
);

server.tool(
  "gate_boolean",
  { context_state: z.string(), assertion: z.string() },
  async ({ context_state, assertion }) => {
    if (!sanitize(context_state) || !sanitize(assertion))
      return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "state+assertion required" }) }], isError: true };
    const r = await gateBoolean(context_state, assertion);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          isError: false, assertion: r.assertion, is_true: r.is_true,
          probability_true: r.probability_true,
          verdict: r.is_true ? "FLAGGED" : "ALLOW", degraded_mode: r.degraded_mode,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "decide_all",
  {
    context_state: z.string(),
    question: z.string(),
    options: z.array(z.string()).min(2).max(20),
    assertion: z.string(),
    scale_max: z.number().optional().default(3),
  },
  async ({ context_state, question, options, assertion, scale_max }) => {
    if (!sanitize(context_state)) return { content: [{ type: "text", text: JSON.stringify({ isError: true, message: "context_state empty" }) }], isError: true };
    const r = await decideAll(context_state, question, options, assertion, scale_max);
    return { content: [{ type: "text", text: JSON.stringify({ isError: false, ...r, cache: cacheStats() }, null, 2) }] };
  }
);

await bootstrap((m) => console.error(`[laya] ${m}`)).catch(() => {});
await server.connect(new StdioServerTransport());
console.error("[laya] ready (stdio)");
