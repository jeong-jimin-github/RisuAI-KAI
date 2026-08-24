/**
 * Typed fetch wrapper for the RisuAI-KAI server API.
 *
 * Every server route answers with `ApiResult<T>`; this module unwraps it so
 * callers deal in plain values and `KaiApiError` instead of tagged unions.
 */

import type {
    ApiResult,
    CharacterDetail,
    CharacterCreateBody,
    CharacterImportResult,
    CharacterListQuery,
    CharacterSummary,
    ChatCreateBody,
    ChatDetail,
    ChatGreetingBody,
    ChatMessage,
    ChatSummary,
    ClientUsageStatus,
    LoginBody,
    MessageAppendBody,
    Paged,
    Persona,
    PersonaUpsertBody,
    PublicUser,
    RegisterBody,
    RuntimeConfig,
    SessionInfo,
    SystemStatus,
    ApiErrorCode,
} from '@kai/shared/contract'

export class KaiApiError extends Error {
    constructor(
        readonly code: ApiErrorCode,
        message: string,
        readonly status: number,
        readonly detail?: unknown,
    ) {
        super(message)
        this.name = 'KaiApiError'
    }
    get isAuth() {
        return this.code === 'unauthorized'
    }
}

type Query = Record<string, string | number | boolean | undefined | null>

function qs(query?: Query): string {
    if (!query) return ''
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        p.set(k, String(v))
    }
    const s = p.toString()
    return s ? `?${s}` : ''
}

/** Fired when the server rejects a request as unauthenticated. */
export const onUnauthorized = new Set<() => void>()

async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query; signal?: AbortSignal; form?: FormData } = {},
): Promise<T> {
    const init: RequestInit = {
        method,
        credentials: 'same-origin',
        signal: opts.signal,
        headers: {},
    }
    if (opts.form) {
        init.body = opts.form
    } else if (opts.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(opts.body)
    }

    let res: Response
    try {
        res = await fetch(`/api${path}${qs(opts.query)}`, init)
    } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        throw new KaiApiError('internal', '서버에 연결할 수 없습니다.', 0)
    }

    let payload: ApiResult<T>
    try {
        payload = (await res.json()) as ApiResult<T>
    } catch {
        throw new KaiApiError('internal', `서버 응답을 해석할 수 없습니다 (HTTP ${res.status}).`, res.status)
    }

    if ('error' in payload) {
        const err = new KaiApiError(payload.error.code, payload.error.message, res.status, payload.error.detail)
        if (err.isAuth) for (const fn of onUnauthorized) fn()
        throw err
    }
    return payload.data
}

const get = <T>(p: string, query?: Query, signal?: AbortSignal) => request<T>('GET', p, { query, signal })
const post = <T>(p: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', p, { body, signal })
const put = <T>(p: string, body?: unknown) => request<T>('PUT', p, { body })
const patch = <T>(p: string, body?: unknown) => request<T>('PATCH', p, { body })
const del = <T>(p: string, body?: unknown) => request<T>('DELETE', p, { body })

type GatewayMessage = { role: 'system' | 'user' | 'assistant'; content: string }

async function gatewayCompletion(
    token: string,
    body: { model: string; messages: GatewayMessage[]; max_tokens?: number; temperature?: number },
    signal?: AbortSignal,
): Promise<string> {
    let res: Response
    try {
        res = await fetch('/v1/chat/completions', {
            method: 'POST',
            signal,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ...body, stream: false }),
        })
    } catch (error) {
        if ((error as Error).name === 'AbortError') throw error
        throw new KaiApiError('internal', '추천 답변 서버에 연결할 수 없습니다.', 0)
    }

    const payload = await res.json().catch(() => null) as {
        choices?: { message?: { content?: string } }[]
        error?: { code?: ApiErrorCode; message?: string; detail?: unknown }
    } | null
    if (!res.ok || payload?.error) {
        throw new KaiApiError(
            payload?.error?.code ?? 'internal',
            payload?.error?.message ?? `추천 답변을 생성하지 못했습니다 (HTTP ${res.status}).`,
            res.status,
            payload?.error?.detail,
        )
    }
    const content = payload?.choices?.[0]?.message?.content?.trim()
    if (!content) throw new KaiApiError('internal', '추천 답변이 비어 있습니다.', res.status)
    return content
}

export const api = {
    status: () => get<SystemStatus>('/admin/status'),

    gateway: {
        complete: gatewayCompletion,
    },

    config: {
        get: () => get<RuntimeConfig>('/config'),
        revision: () => get<{ revision: number }>('/config/revision'),
    },

    auth: {
        register: (b: RegisterBody) => post<SessionInfo>('/auth/register', b),
        login: (b: LoginBody) => post<SessionInfo>('/auth/login', b),
        logout: () => post<Record<string, never>>('/auth/logout'),
        session: () => get<SessionInfo>('/auth/session'),
        rotateGatewayToken: () => post<{ gatewayToken: string }>('/auth/gateway-token/rotate'),
    },

    me: {
        get: () => get<PublicUser>('/me'),
        usage: () => get<ClientUsageStatus>('/me/usage'),
        update: (b: { displayName?: string; locale?: string }) => patch<PublicUser>('/me', b),
        setAvatar: (file: File) => {
            const form = new FormData()
            form.append('file', file)
            return request<PublicUser>('POST', '/me/avatar', { form })
        },
        changePassword: (b: { currentPassword: string; newPassword: string }) =>
            post<Record<string, never>>('/me/password', b),
        remove: (password: string) => del<Record<string, never>>('/me', { password }),
    },

    characters: {
        list: (q: CharacterListQuery = {}, signal?: AbortSignal) =>
            get<Paged<CharacterSummary>>('/characters', q as Query, signal),
        detail: (idOrSlug: string, signal?: AbortSignal) =>
            get<CharacterDetail>(`/characters/${encodeURIComponent(idOrSlug)}`, undefined, signal),
        create: (body: CharacterCreateBody) => post<CharacterSummary>('/characters', body),
        update: (id: string, body: Record<string, unknown>) => patch<CharacterSummary>(`/characters/${id}`, body),
        setAvatar: (id: string, file: File) => {
            const form = new FormData()
            form.append('file', file)
            return request<CharacterSummary>('POST', `/characters/${id}/avatar`, { form })
        },
        importFile: (file: File) => {
            const form = new FormData()
            form.append('file', file)
            return request<CharacterImportResult>('POST', '/characters/import', { form })
        },
        importRealm: (input: string, skipLowQuality = false) =>
            post<CharacterImportResult>('/characters/import/realm', { input, skipLowQuality }),
        like: (id: string) => post<{ liked: boolean; likeCount: number }>(`/characters/${id}/like`),
        unlike: (id: string) => del<{ liked: boolean; likeCount: number }>(`/characters/${id}/like`),
        exportUrl: (id: string, format: 'charx' | 'png') => `/api/characters/${id}/export?format=${format}`,
    },

    chats: {
        list: (q: { page?: number; pageSize?: number; characterId?: string } = {}) =>
            get<Paged<ChatSummary>>('/chats', q),
        create: (b: ChatCreateBody) => post<ChatDetail>('/chats', b),
        detail: (id: string, q: { before?: number; limit?: number } = {}) =>
            get<ChatDetail>(`/chats/${id}`, q),
        selectGreeting: (id: string, b: ChatGreetingBody) =>
            put<ChatMessage>(`/chats/${id}/greeting`, b),
        appendMessage: (id: string, b: MessageAppendBody) => post<ChatMessage>(`/chats/${id}/messages`, b),
        deleteMessage: (id: string, idx: number) => del<Record<string, never>>(`/chats/${id}/messages/${idx}`),
        truncate: (id: string, fromIdx: number) => post<Record<string, never>>(`/chats/${id}/truncate`, { fromIdx }),
        addSwipe: (id: string, idx: number, content: string) =>
            post<ChatMessage>(`/chats/${id}/messages/${idx}/swipe`, { content }),
        selectSwipe: (id: string, idx: number, swipeIndex: number) =>
            put<ChatMessage>(`/chats/${id}/messages/${idx}/swipe`, { swipeIndex }),
        update: (id: string, b: { title?: string; pinned?: boolean; archived?: boolean; personaId?: string | null }) =>
            patch<ChatSummary>(`/chats/${id}`, b),
        setState: (id: string, engineState: Record<string, unknown>) =>
            put<Record<string, never>>(`/chats/${id}/state`, { engineState }),
        branch: (id: string, uptoIdx: number) => post<ChatSummary>(`/chats/${id}/branch`, { uptoIdx }),
        remove: (id: string) => del<Record<string, never>>(`/chats/${id}`),
        exportUrl: (id: string) => `/api/chats/${id}/export`,
    },

    personas: {
        list: () => get<Persona[]>('/personas'),
        create: (b: PersonaUpsertBody) => post<Persona>('/personas', b),
        update: (id: string, b: Partial<PersonaUpsertBody>) => patch<Persona>(`/personas/${id}`, b),
        remove: (id: string) => del<Record<string, never>>(`/personas/${id}`),
        setAvatar: (id: string, file: File) => {
            const form = new FormData()
            form.append('file', file)
            return request<Persona>('POST', `/personas/${id}/avatar`, { form })
        },
    },
}

/** Multipart upload for the admin importers (presets, modules, HypaV3). */
export function apiUpload<T>(path: string, file: File, extraFields?: Record<string, string>): Promise<T> {
    const form = new FormData()
    form.append('file', file)
    if (extraFields) {
        for (const [k, v] of Object.entries(extraFields)) {
            form.append(k, v)
        }
    }
    return request<T>('POST', path, { form })
}

export { request as rawRequest, get as apiGet, post as apiPost, patch as apiPatch, del as apiDelete, put as apiPut }
