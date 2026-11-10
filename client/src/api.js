const KEY = 'quizbot_token'
export const getToken = () => localStorage.getItem(KEY)
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY))

let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn)

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (form) payload = form
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/login') onUnauthorized()
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export const money = (n, cur = 'UGX') => `${cur} ${Math.round(Number(n) || 0).toLocaleString('en-US')}`
export const when = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—')
