import { GoogleGenAI } from "@google/genai";
import { ApiError } from "../utils/ApiError.js";

let client = null;
const DEFAULT_MODEL = "gemini-3.6-flash";

const getClient = () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "Gemini API key is not configured. Add GEMINI_API_KEY to the backend .env file."
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
};

const MODEL = () => process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

export const getAIConfiguration = () => {
  const apiKeyConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const model = MODEL();

  return {
    configured: apiKeyConfigured && Boolean(model),
    apiKeyConfigured,
    model,
  };
};

export const isAIConfigured = () => getAIConfiguration().configured;

const classifyGeminiError = (err) => {
  const status = Number(err?.status || err?.statusCode || err?.code);
  const message = String(err?.message || "");
  const lowerMessage = message.toLowerCase();

  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|forbidden/.test(lowerMessage)) {
    return "invalid-key";
  }
  if (status === 404 || /model|not found|unsupported/.test(lowerMessage)) {
    return "invalid-model";
  }
  if (status === 429 || /quota|rate limit|resource exhausted/.test(lowerMessage)) {
    return "quota";
  }
  if (status >= 500 || /timeout| unavailable|provider|upstream/.test(lowerMessage)) {
    return "provider";
  }
  return "request";
};

const redact = (value) => {
  const apiKey = process.env.GEMINI_API_KEY;
  return String(value || "unknown").replace(apiKey || "\u0000", "[REDACTED]");
};

const logGeminiFailure = (operation, model, err, category) => {
  console.error("Gemini request failed", {
    operation,
    model,
    category,
    status: err?.status || err?.statusCode || undefined,
    message: redact(err?.message),
  });
};

const generateJSON = async (prompt, schema) => {
  const ai = getClient();
  const model = MODEL();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.6,
      },
    });
    if (!response?.text) throw new Error("Gemini returned an empty response");
    return JSON.parse(response.text);
  } catch (err) {
    const category = err instanceof SyntaxError || /empty response/.test(err?.message || "")
      ? "response-parsing"
      : classifyGeminiError(err);
    logGeminiFailure("json", model, err, category);
    throw new ApiError(502, "AI request failed. Please try again in a moment.");
  }
};

const generateText = async (prompt, temperature = 0.7) => {
  const ai = getClient();
  const model = MODEL();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature },
    });
    if (!response?.text?.trim()) throw new Error("Gemini returned an empty response");
    return response.text.trim();
  } catch (err) {
    const category = /empty response/.test(err?.message || "")
      ? "response-parsing"
      : classifyGeminiError(err);
    logGeminiFailure("text", model, err, category);
    throw new ApiError(502, "AI request failed. Please try again in a moment.");
  }
};

export const generateLeadSummary = async (lead) => {
  const prompt = `You are an expert B2B sales analyst for a CRM called TTR CRM.
Analyse the following sales lead and produce a concise assessment.

Lead details:
- Name: ${lead.name || "N/A"}
- Company: ${lead.company || "N/A"}
- Email: ${lead.email || "N/A"}
- Current pipeline stage: ${lead.status || "New"}
- Potential deal value: $${lead.value || 0}
- Source: ${lead.source || "Unknown"}
- Notes: ${lead.notes || "None"}

Return JSON only.`;

  const schema = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-3 sentence executive summary of the lead",
      },
      riskScore: {
        type: "integer",
        description: "Risk of losing this deal, 0 (safe) to 100 (high risk)",
      },
      suggestedPriority: {
        type: "string",
        enum: ["Low", "Medium", "High"],
      },
      nextBestAction: {
        type: "string",
        description: "One concrete recommended next step",
      },
    },
    required: ["summary", "riskScore", "suggestedPriority", "nextBestAction"],
  };

  return generateJSON(prompt, schema);
};

export const generateEmail = async ({ lead, purpose, tone, sender }) => {
  const prompt = `You are a senior sales rep writing on behalf of ${sender?.name || "our team"
    }${sender?.company ? ` at ${sender.company}` : ""}.

Write a professional sales email.
Purpose: ${purpose || "follow-up"}
Desired tone: ${tone || "friendly and professional"}

Recipient (lead) details:
- Name: ${lead?.name || "there"}
- Company: ${lead?.company || "N/A"}
- Pipeline stage: ${lead?.status || "New"}
- Context / notes: ${lead?.notes || "None"}

Return JSON only with a compelling subject line and a complete email body.
Use line breaks (\\n) in the body. Keep it under 180 words. Sign off as ${sender?.name || "the TTR CRM team"
    }.`;

  const schema = {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["subject", "body"],
  };

  return generateJSON(prompt, schema);
};

export const generateSalesInsights = async (pipelineStats) => {
  const prompt = `You are a revenue-operations advisor. Given this snapshot of a sales pipeline, identify what is working, what is at risk, and concrete actions to improve conversion.

Pipeline snapshot (JSON):
${JSON.stringify(pipelineStats, null, 2)}

Return JSON only.`;

  const schema = {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One-sentence summary of pipeline health",
      },
      insights: {
        type: "array",
        description: "3-5 specific, data-driven observations",
        items: { type: "string" },
      },
      recommendations: {
        type: "array",
        description: "3-5 prioritized, actionable recommendations",
        items: { type: "string" },
      },
      healthScore: {
        type: "integer",
        description: "Overall pipeline health, 0-100",
      },
    },
    required: ["headline", "insights", "recommendations", "healthScore"],
  };

  return generateJSON(prompt, schema);
};

export { generateText };