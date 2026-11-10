import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Modal, useLoad } from '../components.jsx'

const LETTERS = ['A', 'B', 'C']

function NameModal({ title, label, initial = '', withDescription, initialDescription = '', onClose, onSave }) {
  const [name, setName] = useState(initial)
  const [description, setDescription] = useState(initialDescription)
  const [err, setErr] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    try { await onSave({ name, description }) } catch (e2) { setErr(e2.message) }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>{label}</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        {withDescription && <label className="f"><span>Description <small>(optional)</small></span><input type="text" value={description} onChange={(e) => setDescription(e.target.value)} /></label>}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  )
}

function QuestionModal({ topicId, question, onClose, onSaved }) {
  const [text, setText] = useState(question?.text || '')
  const [options, setOptions] = useState(question?.options || ['', ''])
  const [correct, setCorrect] = useState(question?.correct ?? null)
  const [explanation, setExplanation] = useState(question?.explanation || '')
  const [file, setFile] = useState(null)
  const [removeDoc, setRemoveDoc] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const setOpt = (i, v) => setOptions(options.map((o, k) => (k === i ? v : o)))
  const removeOpt = (i) => {
    setOptions(options.filter((_, k) => k !== i))
    setCorrect((c) => (c === null ? c : c === i ? null : c > i ? c - 1 : c))
  }

  const submit = async (e) => {
    e.preventDefault(); setErr('')
    const clean = options.map((o) => o.trim())
    if (clean.some((o) => !o)) return setErr('Fill in every option or remove the empty ones')
    if (correct === null) return setErr('Select the correct answer')
    const form = new FormData()
    form.set('text', text); form.set('options', JSON.stringify(clean)); form.set('correct', String(correct)); form.set('explanation', explanation)
    if (file) form.set('document', file)
    if (removeDoc) form.set('remove_document', 'true')
    setBusy(true)
    try {
      await api(question ? `/questions/${question.id}` : `/topics/${topicId}/questions`, { method: question ? 'PUT' : 'POST', form })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title={question ? 'Edit question' : 'Add question'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Question</span><textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Answer options <small className="muted" style={{ fontWeight: 400 }}>— up to 3. Select the correct one.</small></span>
          <div className="form" style={{ gap: 8 }}>
            {options.map((o, i) => (
              <div className="optrow" key={i}>
                <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} aria-label={`Option ${LETTERS[i]} is correct`} />
                <input type="text" value={o} onChange={(e) => setOpt(i, e.target.value)} placeholder={`Option ${LETTERS[i]}`} maxLength={200} />
                {options.length > 2 ? <button type="button" className="icon" onClick={() => removeOpt(i)} aria-label={`Remove option ${LETTERS[i]}`}>✕</button> : <span />}
              </div>
            ))}
            {options.length < 3 && <div><button type="button" className="btn sm" onClick={() => setOptions([...options, ''])}>+ Add option</button></div>}
          </div>
        </div>
        <label className="f"><span>Explanation <small>(shown when a student taps Explain)</small></span><textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="Why is this the correct answer?" /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Attached document <small className="muted" style={{ fontWeight: 400 }}>(image, PDF, etc. — sent with the question)</small></span>
          {question?.document_name && !removeDoc && !file && (
            <div className="row"><a href={question.document_url} target="_blank" rel="noreferrer">{question.document_name}</a>
              <button type="button" className="btn sm danger" onClick={() => setRemoveDoc(true)}>Remove</button></div>
          )}
          {removeDoc && !file && <div className="muted">Document will be removed on save.</div>}
          <input type="file" onChange={(e) => setFile(e.target.files[0] || null)} />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save question'}</button>
        </div>
      </form>
    </Modal>
  )
}

export default function QuestionBank() {
  const [courseId, setCourseId] = useState(() => Number(localStorage.getItem('quizbot_course')) || null)
  const [topicId, setTopicId] = useState(null)
  const [modal, setModal] = useState(null)
  const [err, setErr] = useState('')

  const courses = useLoad(() => api('/courses'))
  const topics = useLoad(() => (courseId ? api(`/courses/${courseId}/topics`) : Promise.resolve([])), [courseId])
  const questions = useLoad(() => (topicId ? api(`/topics/${topicId}/questions`) : Promise.resolve([])), [topicId])

  useEffect(() => { if (courseId) localStorage.setItem('quizbot_course', courseId) }, [courseId])
  useEffect(() => { setTopicId(null) }, [courseId])
  useEffect(() => {
    if (courses.data && courseId && !courses.data.some((c) => c.id === courseId)) setCourseId(null)
  }, [courses.data, courseId])

  const course = courses.data?.find((c) => c.id === courseId)
  const topic = topics.data?.find((t) => t.id === topicId)
  const refreshAll = () => { courses.reload(); topics.reload(); questions.reload() }
  const run = async (fn) => { setErr(''); try { await fn() } catch (e) { setErr(e.message) } }

  const del = (what, path, after) => {
    if (!confirm(`Delete this ${what}? This can't be undone.`)) return
    run(async () => { await api(path, { method: 'DELETE' }); after?.(); refreshAll() })
  }

  return (
    <>
      <div className="head"><div><h1>Question bank</h1><p>Courses, sub topics and the questions students practise.</p></div></div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="bank">
        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}><h2>Courses</h2><button className="btn sm primary" onClick={() => setModal({ type: 'course' })}>+ Add</button></div>
          {!courses.data?.length ? <div className="empty">Add your first course.</div> : (
            <div className="list">
              {courses.data.map((c) => (
                <div key={c.id} className={`item ${c.id === courseId ? 'on' : ''}`} onClick={() => setCourseId(c.id)}>
                  <div><div>{c.name}</div><small>{c.topic_count} topics · {c.question_count} questions</small></div>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    <button className="icon" title="Rename" onClick={() => setModal({ type: 'course', item: c })}>✎</button>
                    <button className="icon" title="Delete" onClick={() => del('course and everything in it', `/courses/${c.id}`, () => setCourseId(null))}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}><h2>Sub topics</h2><button className="btn sm primary" disabled={!course} onClick={() => setModal({ type: 'topic' })}>+ Add</button></div>
          {!course ? <div className="empty">Select a course.</div> : !topics.data?.length ? <div className="empty">No sub topics in {course.name} yet.</div> : (
            <div className="list">
              {topics.data.map((t) => (
                <div key={t.id} className={`item ${t.id === topicId ? 'on' : ''}`} onClick={() => setTopicId(t.id)}>
                  <div><div>{t.name}</div><small>{t.question_count} question{t.question_count === 1 ? '' : 's'}</small></div>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    <button className="icon" title="Rename" onClick={() => setModal({ type: 'topic', item: t })}>✎</button>
                    <button className="icon" title="Delete" onClick={() => del('sub topic and its questions', `/topics/${t.id}`, () => setTopicId(null))}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <h2>{topic ? `${topic.name} · questions` : 'Questions'}</h2>
            <button className="btn sm primary" disabled={!topic} onClick={() => setModal({ type: 'question' })}>+ Add question</button>
            <button className="btn sm" disabled={!topic} onClick={() => setModal({ type: 'bulk' })}>Bulk import</button>
          </div>
          {!topic ? <div className="empty">Select a sub topic to see and add its questions.</div> : !questions.data?.length ? <div className="empty">No questions yet. Add the first one.</div> : (
            questions.data.map((q, n) => (
              <div className="q" key={q.id}>
                <div className="row between" style={{ alignItems: 'start' }}>
                  <div><b>{n + 1}.</b> {q.text}</div>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setModal({ type: 'question', item: q })}>Edit</button>
                    <button className="btn sm danger" onClick={() => del('question', `/questions/${q.id}`)}>Delete</button>
                  </div>
                </div>
                <div>{q.options.map((o, i) => <div key={i} className={`opt ${i === q.correct ? 'correct' : ''}`}><b>{LETTERS[i]}.</b> {o} {i === q.correct && <span>✓ correct</span>}</div>)}</div>
                {q.explanation && <div className="expl"><b>Explanation:</b> {q.explanation}</div>}
                {q.document_url && <div>📎 <a href={q.document_url} target="_blank" rel="noreferrer">{q.document_name}</a></div>}
              </div>
            ))
          )}
        </div>
      </div>

      {modal?.type === 'course' && (
        <NameModal title={modal.item ? 'Rename course' : 'Add course'} label="Course name" withDescription initial={modal.item?.name} initialDescription={modal.item?.description}
          onClose={() => setModal(null)}
          onSave={async (v) => {
            const saved = await api(modal.item ? `/courses/${modal.item.id}` : '/courses', { method: modal.item ? 'PUT' : 'POST', body: v })
            setModal(null); if (!modal.item) setCourseId(saved.id); refreshAll()
          }} />
      )}
      {modal?.type === 'topic' && (
        <NameModal title={modal.item ? 'Rename sub topic' : `Add sub topic to ${course?.name}`} label="Sub topic name" initial={modal.item?.name}
          onClose={() => setModal(null)}
          onSave={async (v) => {
            const saved = await api(modal.item ? `/topics/${modal.item.id}` : `/courses/${courseId}/topics`, { method: modal.item ? 'PUT' : 'POST', body: v })
            setModal(null); if (!modal.item) setTopicId(saved.id); refreshAll()
          }} />
      )}
      {modal?.type === 'question' && (
        <QuestionModal topicId={topicId} question={modal.item} onClose={() => setModal(null)} onSaved={() => { setModal(null); refreshAll() }} />
      )}
      {modal?.type === 'bulk' && (
        <BulkImportModal topicId={topicId} onClose={() => setModal(null)} onSaved={() => { setModal(null); refreshAll() }} />
      )}
    </>
  )
}

function BulkImportModal({ topicId, onClose, onSaved }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const submit = async (e) => {
    e.preventDefault(); setErr('')
    setBusy(true)
    try {
      const { imported } = await api(`/topics/${topicId}/questions/bulk`, { method: 'POST', body: { text } })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }
  const analyze = () => {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    let valid = 0, errors = 0
    for (const line of lines) {
      const parts = line.split('|').map((p) => p.trim())
      if (parts.length < 4) { errors++; continue }
      const optionList = parts.slice(0, -2)
      const correctIndex = Number(parts[parts.length - 2])
      if (optionList.length < 2 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionList.length) { errors++; continue }
      valid++
    }
    setPreview({ valid, errors, total: lines.length })
  }
  return (
    <Modal title={`Bulk import questions (max 2000)`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Questions <small className="muted" style={{ fontWeight: 400 }}>(one per line, max 2000)</small></span>
          <textarea value={text} onChange={(e) => { setText(e.target.value); analyze() }} rows={14} placeholder="What is the capital of Uganda?|Kampala|Nairobi|Kigali|0|It is the capital city." /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Format</span>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            `text&#124;option A&#124;option B&#124;option C&#124;correct index (0-based)&#124;explanation`<br />
            Example: `What is 2+2?&#124;3&#124;4&#124;5&#124;2&#124;Because 2+2=4`<br />
            Use at least 2 options, at most 3. Correct index starts at 0. Explanation is optional.
          </div>
        </div>
        {preview && (
          <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 8, marginBottom: 10 }}>
            {preview.valid} valid · {preview.errors} invalid of {preview.total} lines
          </div>
        )}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import questions'}</button>
        </div>
      </form>
    </Modal>
  )
}
