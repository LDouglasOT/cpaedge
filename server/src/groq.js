import OpenAI from "openai"

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPEN_ROUTER_KEY,
})

const VISION_MODEL = "qwen/qwen2.5-vl-72b-instruct"
const TEXT_MODEL = "qwen/qwen-2.5-72b-instruct"

function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`
}

async function callVision(prompt, images, model = VISION_MODEL, jsonMode = false) {
  const content = [{ type: "text", text: prompt }]
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: toDataUrl(img.buffer, img.mime) } })
  }
  return callVisionContent(content, model, jsonMode)
}

// Send a pre-built content array (text + image_url parts, in order).
async function callVisionContent(content, model = VISION_MODEL, jsonMode = false) {
  const chat = await openrouter.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    temperature: 0.1,
    max_tokens: 1200,
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

export async function gradeLongAnswer({ questionText, questionImages, modelAnswer, modelAnswerImages, studentAnswerText, studentAnswerImages, explanation }) {
  // Build the message content with clear text labels placed BEFORE each image group.
  // Interleaving labels with images is far more reliable than dumping all images at
  // the end, which is why the model kept replying "no student answer provided".
  const content = []
  const pushText = (t) => content.push({ type: 'text', text: t })
  const pushImages = (list, mime) => {
    for (const i of list || []) {
      if (!i || !i.buffer) continue
      content.push({ type: 'image_url', image_url: { url: toDataUrl(i.buffer, i.mime || mime || 'image/jpeg') } })
    }
  }

  pushText('You are an expert examiner. Grade the student\'s answer against the question and the model answer.')

  const hasQText = questionText && questionText.trim() && questionText !== '(Image question)'
  if (hasQText) pushText('QUESTION:\n' + questionText)
  if (questionImages && questionImages.length) {
    pushText('QUESTION IMAGE(S):')
    pushImages(questionImages)
  }

  if (modelAnswer && modelAnswer.trim()) pushText('MODEL ANSWER (correct solution):\n' + modelAnswer)
  if (modelAnswerImages && modelAnswerImages.length) {
    pushText('MODEL ANSWER IMAGE(S) (correct solution):')
    pushImages(modelAnswerImages)
  }

  if (explanation && explanation.trim()) pushText('MARKING GUIDE (from teacher):\n' + explanation)

  const hasStudentText = studentAnswerText && studentAnswerText.trim()
  if (hasStudentText) pushText('STUDENT ANSWER (text):\n' + studentAnswerText)
  if (studentAnswerImages && studentAnswerImages.length) {
    pushText('STUDENT ANSWER IMAGE(S) — this is the student\'s work to be graded:')
    pushImages(studentAnswerImages)
  } else if (!hasStudentText) {
    pushText('STUDENT ANSWER: (none provided)')
  }

  pushText('Now grade the STUDENT ANSWER. Read the student\'s work carefully (handwriting, numbers, working). ' +
    'Compare it to the model answer. Point out any mistakes and explain how to fix them. ' +
    'If the student\'s work is clearly about a different question/topic, say so and score 0. ' +
    'Output ONLY valid JSON: { "score": <0-100>, "feedback": "<detailed feedback>" }')

  const hasImages = content.some((c) => c.type === 'image_url')
  const raw = hasImages
    ? await callVisionContent(content, VISION_MODEL, true)
    : await callText(content.map((c) => c.text).join('\n'), TEXT_MODEL, true)

  // Debug: log raw response
  console.log('[ai] raw response:', raw)

  // Extract JSON from response (handle markdown code blocks, extra text)
  let jsonStr = raw.trim()
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (codeBlockMatch) jsonStr = codeBlockMatch[1]
  const firstBrace = jsonStr.indexOf('{')
  const lastBrace = jsonStr.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonStr)
    return { score: Math.max(0, Math.min(100, Number(parsed.score) || 0)), feedback: String(parsed.feedback || "No feedback") }
  } catch (e) {
    console.error('[ai] JSON parse failed:', e.message, 'raw:', raw)
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