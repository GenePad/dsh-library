// The plugin's authenticated API endpoints: the buffered JSON channel and the
// streaming NDJSON translate route.
const ROUTE = 'api/library'
const TRANSLATE_ROUTE = 'api/library/translate'

export async function call(endpoint, payload, signal) {
  let response
  try {
    response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('无法连接 dsh 宿主，请确认应用仍在运行'), { code: 'library/network', cause: error })
  }
  if (!response.ok) throw Object.assign(new Error(`请求失败（HTTP ${response.status}）`), { code: `library/http-${response.status}` })
  const result = await response.json().catch(() => ({ ok: false, error: { message: '响应不是有效 JSON' } }))
  if (!result.ok) {
    throw Object.assign(new Error(result.error?.message ?? '请求失败'), { code: result.error?.code ?? 'library/error' })
  }
  return result.value
}

/**
 * Stream one reader translation. The host answers with an NDJSON body of
 * {type:'thinking'|'answer'|'done'|'error', ...} events; pre-flight failures
 * come back as a JSON error body with a non-200 status.
 */
export async function streamTranslate(payload, signal, onEvent) {
  let response
  try {
    response = await fetch(TRANSLATE_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('无法连接 dsh 宿主，请确认应用仍在运行'), { code: 'library/network', cause: error })
  }
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const body = await response.json()
      message = body?.error?.message ?? message
    } catch { /* non-JSON error body */ }
    throw Object.assign(new Error(message), { code: `library/http-${response.status}` })
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw Object.assign(new Error('当前环境不支持流式响应'), { code: 'library/no-stream' })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue // tolerate a torn line rather than killing the stream
      }
      if (event?.type) onEvent(event)
    }
  }
}
