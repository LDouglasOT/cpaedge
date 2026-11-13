import OpenAI from "openai"

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPEN_ROUTER_KEY,
})

const VISION_MODEL = "qwen/qwen2.5-vl-72b-instruct"
const TEXT_MODEL = "qwen/qwen2.5-72b-instruct"

function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`
}

async function callVision(prompt, images, model = VISION_MODEL, jsonMode = false) {
  const content = [{ type: "text", text: prompt }]
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: toDataUrl(img.buffer, img.mime) } })
  }
  const chat = await openrouter.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    temperature: 0.2,
    max_tokens: 1024,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  })
  return chat.choices[0]?.message?.content?.trim() || ""
}

async function callText(prompt, model = TEXT_MODEL, jsonMode = false) {
  const chat = await openrouter.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 1024,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  })
  return chat.choices[0]?.message?.content?.trim() || ""
}

export async function gradeLongAnswer({ questionText, modelAnswer, modelAnswerImages, studentAnswerText, studentAnswerImages, explanation }) {
  const prompt = `You are an expert examiner. Grade the student's answer against the model answer.

QUESTION:
${questionText}

${explanation ? `EXPLANATION (provided by teacher):\n${explanation}\n` : ''}MODEL ANSWER (text):
${modelAnswer || "(none provided)"}

STUDENT ANSWER (text):
${studentAnswerText || "(none provided)"}

STUDENT ANSWER IMAGES: ${studentAnswerImages && studentAnswerImages.length > 0 ? "ATTACHED - Analyze these images as the student's written work" : "NONE PROVIDED"}

MODEL ANSWER IMAGES: ${modelAnswerImages && modelAnswerImages.length > 0 ? "ATTACHED" : "NONE PROVIDED"}

QUESTION IMAGES: ATTACHED (if any)

Instructions:
- Compare the student's answer (text AND images) to the model answer (text AND images).
- Use the teacher's explanation as a reference for the expected solution approach.
- Provide a score from 0 to 100.
- Provide concise feedback explaining the score.
- Output ONLY valid JSON: { "score": <0-100>, "feedback": "<string>" }`

  const images = [
    ...(modelAnswerImages || []).map(i => ({ buffer: i.buffer, mime: i.mime })),
    ...(studentAnswerImages || []).map(i => ({ buffer: i.buffer, mime: i.mime }))
  ].filter(Boolean)

  const raw = images.length > 0
    ? await callVision(prompt, images, VISION_MODEL, true)
    : await callText(prompt, TEXT_MODEL, true)

  // Debug: log raw response
  console.log('[groq] raw response:', raw)

  // Extract JSON from response (handle markdown code blocks, extra text)
  let jsonStr = raw.trim()
  // Remove markdown code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (codeBlockMatch) jsonStr = codeBlockMatch[1]
  // Find first { and last }
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonStr)
    return { score: Math.max(0, Math.min(100, Number(parsed.score) || 0)), feedback: String(parsed.feedback || "No feedback") }
  } catch (e) {
    console.error('[groq] JSON parse failed:', e.message, 'raw:', raw)
    return { score: 0, feedback: "AI grading failed to produce valid JSON" }
  }
}

export async function generateExplanation({ questionText, questionImages, modelAnswer, modelAnswerImages }) {
  const prompt = `You are a helpful tutor. Generate a clear, step-by-step explanation for the following question.

QUESTION:
${questionText}

MODEL ANSWER (text):
${modelAnswer || "(none provided)"}

Instructions:
- Explain how to arrive at the correct answer.
- Be concise but thorough.
- Use simple language suitable for a student.
- Format with clear steps or sections.
- Output ONLY the explanation text (no JSON).`

  const images = [
    ...(questionImages || []).map(i => ({ buffer: i.buffer, mime: i.mime })),
    ...(modelAnswerImages || []).map(i => ({ buffer: i.buffer, mime: i.mime }))
  ].filter(Boolean)

  return images.length > 0
    ? await callVision(prompt, images, VISION_MODEL, false)
    : await callText(prompt, TEXT_MODEL, false)
}