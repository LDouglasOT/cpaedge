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

function TopicModal({ courseId, topic, parentId, onClose, onSaved, topics }) {
  const [name, setName] = useState(topic?.name || '')
  const [headerImage, setHeaderImage] = useState(null)
  const [removeHeader, setRemoveHeader] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setErr('')
    if (!name.trim()) return setErr('Topic name is required')
    const form = new FormData()
    form.set('name', name)
    if (parentId) form.set('parentId', parentId)
    if (headerImage) form.set('headerImage', headerImage)
    if (removeHeader) form.set('remove_header', 'true')
    setBusy(true)
    try {
      await api(topic ? `/topics/${topic.id}` : `/courses/${courseId}/topics`, { method: topic ? 'PUT' : 'POST', form })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title={topic ? 'Edit topic' : parentId ? 'Add submenu' : 'Add topic'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Topic name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Header image <small className="muted" style={{ fontWeight: 400 }}>(shown in WhatsApp menu)</small></span>
          {topic?.headerImage && !removeHeader && !headerImage && (
            <div className="row"><a href={`/uploads/${topic.headerImage}`} target="_blank" rel="noreferrer">Current image</a>
              <button type="button" className="btn sm danger" onClick={() => setRemoveHeader(true)}>Remove</button></div>
          )}
          {removeHeader && !headerImage && <div className="muted">Header image will be removed on save.</div>}
          <input type="file" accept="image/*" onChange={(e) => setHeaderImage(e.target.files[0] || null)} />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save topic'}</button>
        </div>
      </form>
    </Modal>
  )
}

function BulkTopicImportModal({ courseId, onClose, onSaved }) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setErr('')
    if (!text.trim()) return setErr('Paste topics to import')
    setBusy(true)
    try {
      await api(`/courses/${courseId}/topics/bulk`, { method: 'POST', body: { text } })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title="Bulk import topics & submenus" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Paste topics (one per line)</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder="Format: Topic Name|Parent Menu Name
Example:
Financial Accounting
Cost Accounting|Financial Accounting
Management Accounting|Financial Accounting
Taxation|Financial Accounting" />
          <small className="muted">Format: <code>Topic Name|Parent Menu Name</code> (parent is optional). Submenus must reference existing parent topics.</small>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !text.trim()}>{busy ? 'Importing…' : 'Import topics'}</button>
        </div>
      </form>
    </Modal>
  )
}

function QuestionModal({ topicId, question, onClose, onSaved }) {
  const initialOptions = Array.isArray(question?.options) && question.options.length === 3 ? question.options : ['', '', '']
  const [text, setText] = useState(question?.text || '')
  const [options, setOptions] = useState(initialOptions)
  const [correct, setCorrect] = useState(Number.isInteger(question?.correct) ? question.correct : 0)
  const [explanation, setExplanation] = useState(question?.explanation || '')
  const [file, setFile] = useState(null)
  const [removeDoc, setRemoveDoc] = useState(false)
  const [headerImage, setHeaderImage] = useState(null)
  const [removeHeader, setRemoveHeader] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const setOpt = (i, v) => setOptions(options.map((o, k) => (k === i ? v : o)))

  const submit = async (e) => {
    e.preventDefault(); setErr('')
    const clean = options.map((o) => o.trim())
    if (clean.some((o) => !o)) return setErr('Fill in all three answers (A, B, C)')
    if (!(correct >= 0 && correct <= 2)) return setErr('Select the correct answer')
    const form = new FormData()
    form.set('text', text); form.set('options', JSON.stringify(clean)); form.set('correct', String(correct)); form.set('explanation', explanation)
    if (file) form.set('document', file)
    if (removeDoc) form.set('remove_document', 'true')
    if (headerImage) form.set('headerImage', headerImage)
    if (removeHeader) form.set('remove_header', 'true')
    setBusy(true)
    try {
      await api(question ? `/questions/${question.id}` : `/topics/${topicId}/questions`, { method: question ? 'PUT' : 'POST', form })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title={question ? 'Edit question' : 'Add question'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="f"><span>Question</span><textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={4} placeholder="Enter your question here (supports multiple lines)" /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Answers <small className="muted" style={{ fontWeight: 400 }}>� Options A, B, C are fixed. Enter each answer and tick the correct one.</small></span>
          <div className="form" style={{ gap: 8 }}>
            {LETTERS.map((letter, i) => (
              <div className="optrow" key={letter}>
                <input type="radio" name="correct" checked={correct === i} onChange={() => setCorrect(i)} aria-label={`Option ${letter} is correct`} />
                <div style={{ fontWeight: 600, width: 18 }}>{letter}.</div>
                <input type="text" value={options[i] || ''} onChange={(e) => setOpt(i, e.target.value)} placeholder={`Answer ${letter}`} maxLength={200} />
              </div>
            ))}
          </div>
        </div>
        <label className="f"><span>Explanation <small>(shown when a student taps Explain)</small></span><textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="Why is this the correct answer?" rows={3} /></label>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Header image <small className="muted" style={{ fontWeight: 400 }}>(shown at top of question in WhatsApp)</small></span>
          {question?.headerImage && !removeHeader && !headerImage && (
            <div className="row"><a href={question.header_url} target="_blank" rel="noreferrer">Current image</a>
              <button type="button" className="btn sm danger" onClick={() => setRemoveHeader(true)}>Remove</button></div>
          )}
          {removeHeader && !headerImage && <div className="muted">Header image will be removed on save.</div>}
          <input type="file" accept="image/*" onChange={(e) => setHeaderImage(e.target.files[0] || null)} />
        </div>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Attached image/document <small className="muted" style={{ fontWeight: 400 }}>(image, PDF, etc. � sent with the question)</small></span>
          {question?.document_name && !removeDoc && !file && (
            <div className="row"><a href={question.document_url} target="_blank" rel="noreferrer">{question.document_name}</a>
              <button type="button" className="btn sm danger" onClick={() => setRemoveDoc(true)}>Remove</button></div>
          )}
          {removeDoc && !file && <div className="muted">Document will be removed on save.</div>}
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} />
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !text.trim()}>{busy ? 'Saving�' : 'Save question'}</button>
        </div>
      </form>
    </Modal>
  )
}

function TopicDropdown({ topics, onSelect, onAddChild, onEdit, onDelete, selectedId, parentId = null, depth = 0 }) {
  if (!topics?.length) return null
  return (
    <div style={{ marginLeft: depth * 16 }}>
      {topics.map((t) => (
        <div key={t.id} className={`item ${t.id === selectedId ? 'on' : ''}`}>
          <div className="row between" style={{ alignItems: 'center' }}>
            <div onClick={() => onSelect(t.id)} style={{ cursor: 'pointer', flex: 1 }}>
              <div style={{ fontWeight: t.question_count > 0 ? 600 : 400 }}>
                {'  '.repeat(depth)}{t.name} {t.headerImage && <span style={{ color: 'var(--primary)' }}>📷</span>}
              </div>
              <small>{t.question_count} question{t.question_count === 1 ? '' : 's'}{t.children?.length ? ' · has submenus' : ''}</small>
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <button className="icon" title="Add submenu" onClick={() => onAddChild(t.id)}>➕</button>
              <button className="icon" title="Edit" onClick={() => onEdit(t)}>✎</button>
              <button className="icon" title="Delete" onClick={() => onDelete(t.id)}>🗑</button>
            </div>
          </div>
          {t.children?.length && <TopicDropdown topics={t.children} onSelect={onSelect} onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} selectedId={selectedId} parentId={t.id} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

export default function QuestionBank() {
  const [courseId, setCourseId] = useState(() => localStorage.getItem('quizbot_course') || null)
  const [topicId, setTopicId] = useState(null)
  const [modal, setModal] = useState(null)
  const [err, setErr] = useState('')

  const courses = useLoad(() => api('/courses'))
  const topicsTree = useLoad(() => (courseId ? api(`/courses/${courseId}/topics/tree`) : Promise.resolve([])), [courseId])
  const topicsFlat = useLoad(() => (courseId ? api(`/courses/${courseId}/topics`) : Promise.resolve([])), [courseId])
  const questions = useLoad(() => (topicId ? api(`/topics/${topicId}/questions`) : Promise.resolve([])), [topicId])

  useEffect(() => { if (courseId) localStorage.setItem('quizbot_course', courseId) }, [courseId])
  useEffect(() => { setTopicId(null) }, [courseId])
  useEffect(() => {
    if (courses.data && courseId && !courses.data.some((c) => c.id === courseId)) setCourseId(null)
  }, [courses.data, courseId])

  const course = courses.data?.find((c) => c.id === courseId)
  const topic = topicsFlat.data?.find((t) => t.id === topicId)
  const refreshAll = () => { courses.reload(); topicsTree.reload(); topicsFlat.reload(); questions.reload() }
  const run = async (fn) => { setErr(''); try { await fn() } catch (e) { setErr(e.message) } }

  const del = (what, path, after) => {
    if (!confirm(`Delete this ${what}? This can't be undone.`)) return
    run(async () => { await api(path, { method: 'DELETE' }); after?.(); refreshAll() })
  }

  return (
    <>
      <div className="head"><div><h1>Question bank</h1><p>Levels, topics, submenus and the questions students practise.</p></div></div>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="bank">
<div className="card">
        <div className="row between" style={{ marginBottom: 10 }}><h2>Levels</h2><button className="btn sm primary" onClick={() => setModal({ type: 'course' })}>+ Add</button></div>
          {!courses.data?.length ? <div className="empty">Add your first level.</div> : (
            <div className="list">
              {courses.data.map((c) => (
                <div key={c.id} className={`item ${c.id === courseId ? 'on' : ''}`} onClick={() => setCourseId(c.id)}>
                  <div><div>{c.name}</div><small>{c.topic_count} topics · {c.question_count} questions</small></div>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    <button className="icon" title="Rename" onClick={() => setModal({ type: 'course', item: c })}>✎</button>
                    <button className="icon" title="Delete" onClick={() => del('level and everything in it', `/courses/${c.id}`, () => setCourseId(null))}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

<div className="card">
        <div className="row between" style={{ marginBottom: 10 }}><h2>Topics & Submenus</h2>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm primary" disabled={!course} onClick={() => setModal({ type: 'topic', parentId: null })}>+ Add topic</button>
              <button className="btn sm" disabled={!course} onClick={() => setModal({ type: 'bulkTopic' })}>Bulk import</button>
            </div>
          </div>
          {!course ? <div className="empty">Select a course.</div> : !topicsTree.data?.length ? <div className="empty">No topics in {course.name} yet. Click + Add topic to start.</div> : (
            <div className="list">
              <TopicDropdown 
                topics={topicsTree.data} 
                onSelect={setTopicId} 
                onAddChild={(parentId) => setModal({ type: 'topic', parentId })} 
                onEdit={(t) => setModal({ type: 'topic', item: t, parentId: t.parentId })} 
                onDelete={(id) => del('topic and its questions', `/topics/${id}`, () => setTopicId(null))}
                selectedId={topicId}
              />
            </div>
          )}
        </div>

        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <h2>{topic ? `${topic.name} · questions` : 'Questions'}</h2>
            <button className="btn sm primary" disabled={!topic} onClick={() => setModal({ type: 'question' })}>+ Add question</button>
            <button className="btn sm" disabled={!topic} onClick={() => setModal({ type: 'bulk' })}>Bulk import (Excel)</button>
          </div>
          {!topic ? <div className="empty">Select a topic to see and add its questions.</div> : !questions.data?.length ? <div className="empty">No questions yet. Add the first one.</div> : (
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
        <TopicModal 
          courseId={courseId} 
          topic={modal.item} 
          parentId={modal.parentId} 
          topics={topicsFlat.data} 
          onClose={() => setModal(null)} 
          onSaved={() => { setModal(null); refreshAll() }} 
        />
      )}
      {modal?.type === 'bulkTopic' && (
        <BulkTopicImportModal courseId={courseId} onClose={() => setModal(null)} onSaved={() => { setModal(null); refreshAll() }} />
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
  const [file, setFile] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault(); setErr('')
    if (!file) return setErr('Choose an Excel file to upload')
    const form = new FormData()
    form.set('file', file)
    setBusy(true)
    try {
      await api(`/topics/${topicId}/questions/bulk`, { method: 'POST', form })
      onSaved()
    } catch (e2) { setErr(e2.message); setBusy(false) }
  }

  return (
    <Modal title="Bulk import questions from Excel" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Excel file (.xlsx, .xls)</span>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div className="f"><span style={{ fontWeight: 500, fontSize: 13 }}>Required columns</span>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
            <b>question</b> | <b>first answer</b> | <b>second answer</b> | <b>third answer</b> | <b>correct answer</b> | <i>explanation (optional)</i><br />
            Correct answer must be <b>A</b>, <b>B</b>, or <b>C</b> (matching first/second/third).<br />
            Options A, B, C are fixed by default � only tick/select the correct answer in that column.<br />
            Example: <code>What is 2+1? | 3 | 1 | 2 | A | 2+1 equals 3</code>
          </div>
        </div>
        {file && <div style={{ padding: 10, background: 'var(--bg)', borderRadius: 8 }}>Selected: <b>{file.name}</b></div>}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !file}>{busy ? 'Importing�' : 'Import questions'}</button>
        </div>
      </form>
    </Modal>
  )
}