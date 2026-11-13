import { config, aiProvider } from './config.js';
import { q } from './db.js';

const TIMEOUT_MS = 45000;

async function callAnthropic(system, messages, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message || 'request failed'}`);
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function callOpenAI(system, messages, maxTokens) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify({
      model: config.openaiModel,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || 'request failed'}`);
  return data.choices?.[0]?.message?.content || '';
}

async function complete(kind, system, messages, maxTokens) {
  const provider = aiProvider();
  const t0 = Date.now();
  try {
    const text = provider === 'anthropic'
      ? await callAnthropic(system, messages, maxTokens)
      : await callOpenAI(system, messages, maxTokens);
    q.run('INSERT INTO ai_usage(kind, provider, ok, ms) VALUES (?,?,?,?)', kind, provider, 1, Date.now() - t0);
    return text;
  } catch (e) {
    q.run('INSERT INTO ai_usage(kind, provider, ok, ms) VALUES (?,?,?,?)', kind, provider, 0, Date.now() - t0);
    throw e;
  }
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI returned no JSON array');
  return JSON.parse(text.slice(start, end + 1));
}

function validQuestion(x) {
  return x && typeof x.question === 'string' && x.question.trim().length > 5
    && Array.isArray(x.options) && x.options.length === 4
    && x.options.every((o) => typeof o === 'string' && o.trim())
    && new Set(x.options.map((o) => o.trim().toLowerCase())).size === 4
    && Number.isInteger(x.answer) && x.answer >= 0 && x.answer <= 3
    && typeof x.explanation === 'string' && x.explanation.trim();
}

// Generate multiple-choice questions for one topic. Returns validated question objects.
export async function generateQuestions({ grade, subject, topic, count = 8, avoid = [] }) {
  const provider = aiProvider();
  if (provider === 'demo') return demoQuestions({ grade, subject, topic, count });

  const system = `You are an experienced Zambian teacher and ECZ examiner writing practice questions.
Write accurate, unambiguous multiple-choice questions at the standard of the Zambian Grade ${grade} examination.
Use Zambian contexts (names, places, Kwacha) where natural. British English spelling.
Exactly one option must be correct. Distractors must be plausible. No "all of the above" / "none of the above".
Explanations: 1-3 short sentences a learner can follow, showing working for calculations.
Respond with ONLY a JSON array, no prose.`;
  const avoidText = avoid.length ? `\nDo not repeat these existing questions:\n- ${avoid.slice(0, 25).join('\n- ')}` : '';
  const user = `Subject: ${subject}\nTopic: ${topic}\nGrade: ${grade}\nWrite ${count} questions of mixed difficulty.${avoidText}
JSON format: [{"question": "...", "options": ["A text","B text","C text","D text"], "answer": 0, "explanation": "..."}]
"answer" is the 0-based index of the correct option. Vary the position of the correct answer.`;

  const text = await complete('questions', system, [{ role: 'user', content: user }], 4000);
  const arr = extractJsonArray(text);
  return arr.filter(validQuestion).map((x) => ({
    question: x.question.trim(),
    options: x.options.map((o) => o.trim().replace(/^[A-D][).:]\s+/, '')),
    answer: x.answer,
    explanation: x.explanation.trim(),
    source: provider,
  }));
}

// Tutor reply in the learner's chosen language.
export async function tutorReply({ grade, language, history, message }) {
  const provider = aiProvider();
  if (provider === 'demo') {
    return `(Demo mode: the AI tutor is not connected yet.) You asked: "${message.slice(0, 200)}". Once the administrator adds an AI key, I will explain this step by step in ${language} at Grade ${grade} level.`;
  }
  const system = `You are ZedPrep Tutor, a patient and encouraging tutor for a Zambian Grade ${grade} learner preparing for ECZ examinations.
Reply in ${language}${language !== 'English' ? ' (keep technical and subject terms in English where learners normally use them, and add the English term in brackets if helpful)' : ''}.
Teach, do not just give answers: explain step by step, check understanding, and give one short practice question at the end when useful.
Keep replies short and clear for reading on a phone (under 200 words unless working is needed). Use simple formatting: short paragraphs, numbered steps.
Stay on school subjects and study skills. If asked something unsafe or unrelated, gently steer back to learning.`;
  const msgs = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: message }];
  return (await complete('tutor', system, msgs, 900)).trim();
}

// Demo questions so the app is fully usable before an AI key is added. Clearly labelled.
function demoQuestions({ subject, topic, count }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = 3 + ((i * 7) % 11), b = 2 + ((i * 5) % 9);
    const correct = a * b;
    const opts = [correct, correct + b, correct - a, correct + 2 * a];
    const pos = i % 4;
    [opts[0], opts[pos]] = [opts[pos], opts[0]];
    out.push({
      question: `[Demo - ${subject}: ${topic}] What is ${a} × ${b}?`,
      options: opts.map(String),
      answer: pos,
      explanation: `${a} × ${b} = ${correct}. Demo question: real ${subject} questions appear once an AI key is configured.`,
      source: 'demo',
    });
  }
  return out;
}
