// The plugin's single authenticated API endpoint.
const ROUTE = 'api/library'

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
