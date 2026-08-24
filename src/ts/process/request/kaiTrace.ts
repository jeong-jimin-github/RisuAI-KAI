export const KAI_ACTIVE_CHAT_ID_KEY = '__kaiActiveServerChatId'

export function attachKaiChatTrace(
    body: Record<string, any>,
    options: { aiModel?: string; chatId?: unknown; sameOrigin: boolean },
): void {
    if (
        options.aiModel === 'reverse_proxy' &&
        options.sameOrigin &&
        typeof options.chatId === 'string' &&
        options.chatId.trim()
    ) {
        body.kai_chat_id = options.chatId
    }
}
