import { getToken } from './store'

const API = 'https://api.github.com'

export class GitHub {
  constructor(private token: string) {}

  static forAccount(accountId: string, label = 'This account'): GitHub {
    const token = getToken(accountId)
    if (!token) throw new Error(`${label} has no GitHub token, so GitHub features are unavailable. Add a token in Accounts.`)
    return new GitHub(token)
  }

  async request<T = any>(method: string, url: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'RepoDock',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const j = await res.json()
        msg = j.message + (j.errors ? ' — ' + j.errors.map((e: any) => e.message || e.code).join(', ') : '')
      } catch {}
      if (res.status === 401) msg = 'The token was rejected (wrong, expired or revoked). Create a new one and paste it again.'
      if (res.status === 403 || res.status === 404) msg += ' (check that the token has the needed scopes/permissions)'
      throw new Error(`GitHub ${res.status}: ${msg}`)
    }
    const data = res.status === 204 ? (null as T) : await res.json().catch(() => null as T)
    return { data, headers: res.headers }
  }

  async get<T = any>(url: string): Promise<T> {
    return (await this.request<T>('GET', url)).data
  }

  /** Follows Link headers; stops after `max` items. */
  async paginate<T = any>(url: string, max = 500): Promise<T[]> {
    const out: T[] = []
    let next: string | null = url
    while (next && out.length < max) {
      const { data, headers }: { data: T[]; headers: Headers } = await this.request<T[]>('GET', next)
      out.push(...data)
      next = headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
    }
    return out
  }

  post = <T = any>(url: string, body?: unknown) => this.request<T>('POST', url, body ?? {}).then((r) => r.data)
  patch = <T = any>(url: string, body: unknown) => this.request<T>('PATCH', url, body).then((r) => r.data)
  put = <T = any>(url: string, body: unknown) => this.request<T>('PUT', url, body).then((r) => r.data)
  delete = (url: string) => this.request('DELETE', url).then(() => undefined)

  async whoami(): Promise<{ login: string; name?: string; avatarUrl?: string; scopes: string }> {
    const { data, headers } = await this.request('GET', '/user')
    return { login: data.login, name: data.name ?? undefined, avatarUrl: data.avatar_url, scopes: headers.get('x-oauth-scopes') ?? 'fine-grained' }
  }
}
