-- 004_long_questions.sql
-- Extend questions for objective/long types, multi-page question/answer images, and model answers
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'objective',
  ADD COLUMN IF NOT EXISTS question_images TEXT,
  ADD COLUMN IF NOT EXISTS prompt_type TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS answer_type TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS model_answer TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model_answer_images TEXT,
  ADD COLUMN IF NOT EXISTS model_answer_mime TEXT;

-- Extend attempts for long-form submissions and grading
ALTER TABLE attempts
  ALTER COLUMN selected SET DEFAULT -1,
  ALTER COLUMN is_correct SET DEFAULT false,
  ADD COLUMN IF NOT EXISTS answer_text TEXT,
  ADD COLUMN IF NOT EXISTS answer_images TEXT,
  ADD COLUMN IF NOT EXISTS answer_mime TEXT,
  ADD COLUMN IF NOT EXISTS score INTEGER,
  ADD COLUMN IF NOT EXISTS feedback TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS graded BOOLEAN NOT NULL DEFAULT false;
