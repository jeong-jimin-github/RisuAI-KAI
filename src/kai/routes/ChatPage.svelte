<script lang="ts">
    import type { CharacterDetail, ChatDetail, ChatSummary, Persona } from '@kai/shared/contract'
    import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, CircleAlert, ImageUp, Info, List, LoaderCircle, MessageCircle, Plus, RotateCcw, Send, Square, Trash2, UserRoundPen, WandSparkles, X } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import BackgroundDom from '../../lib/ChatScreens/BackgroundDom.svelte'
    import { api } from '../api/client'
    import ChatMessageBody from '../components/ChatMessageBody.svelte'
    import MultiLangText from '../components/MultiLangText.svelte'
    import {
        activateEngineControl,
        appendEngineUserMessage,
        deleteEngineMessage,
        discardEngineMessagesAfter,
        engineState,
        generate,
        loadChatIntoEngine,
        readEngineMessages,
        setEngineGreeting,
        setEnginePersona,
        syncChat,
        truncateForRegenerate,
        type EngineChatMessage,
        type GenerateHandle,
    } from '../engine/bridge.svelte'
    import { parseReplySuggestions } from '../lib/replySuggestions'
    import { router } from '../lib/router.svelte'
    import { appConfig, session, toasts } from '../stores/app.svelte'

    let { chatId }: { chatId: string } = $props()
    let chat = $state<ChatDetail | null>(null)
    let char = $state<CharacterDetail | null>(null)
    let messages = $state<EngineChatMessage[]>([])
    let text = $state('')
    let loading = $state(true)
    let handle = $state<GenerateHandle | null>(null)
    let scroller = $state<HTMLDivElement>()
    let renderRevision = $state(0)
    let usageOpen = $state(false)
    let usageLoading = $state(false)
    let personas = $state<Persona[]>([])
    let activePersona = $state<Persona | null>(null)
    let personaEditorOpen = $state(false)
    let personaName = $state('')
    let personaPrompt = $state('')
    let personaAvatar = $state<File | null>(null)
    let personaSaving = $state(false)
    let greetingOptions = $state<{ index: number; name: string; content: string }[]>([])
    let greetingPosition = $state(-1)
    let greetingSwitching = $state(false)
    let failedUserMessageIndex = $state<number | null>(null)
    let suggestionMenuOpen = $state(false)

    let inputEl = $state<HTMLTextAreaElement>()
    /** Turn whose meta row (time, model, delete) is revealed by a tap. */
    let openMetaIndex = $state<number | null>(null)

    /**
     * Reveals a turn's controls on tap.
     *
     * Hover is what uncovers them on a desktop, and a phone has no hover — which
     * is why the delete button was unreachable there. A tap on the passage
     * itself toggles the row, while taps that mean something else (a control
     * inside the message, or selecting text to copy) are left alone.
     */
    function toggleTurnMeta(index: number, event: MouseEvent) {
        const target = event.target
        if (target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]')) return
        if ((window.getSelection()?.toString() ?? '').length > 0) return
        openMetaIndex = openMetaIndex === index ? null : index
    }

    /** Longest composer the dock may grow to before the textarea scrolls instead. */
    const composerMaxHeight = 168

    /**
     * Grows the composer with its content up to `composerMaxHeight`.
     *
     * `height: auto` first so the box can also *shrink* when text is deleted;
     * reading `scrollHeight` while the old height is still applied would keep
     * the tallest size the input ever reached.
     */
    function resizeInput() {
        const el = inputEl
        if (!el) return
        el.style.height = 'auto'
        const next = Math.min(el.scrollHeight, composerMaxHeight)
        el.style.height = `${next}px`
        el.style.overflowY = el.scrollHeight > composerMaxHeight ? 'auto' : 'hidden'
    }

    function autoGrow() {
        resizeInput()
    }

    // Anything that rewrites `text` from code — sending, a reply suggestion, a
    // failed send restoring the draft — has to re-measure too.
    $effect(() => {
        text
        if (inputEl) resizeInput()
    })

    // Streaming grows the last turn without firing a scroll event, so the arrows
    // are re-evaluated whenever the rendered conversation changes.
    $effect(() => {
        messages.length
        renderRevision
        engineState.generating
        if (scroller) requestAnimationFrame(refreshScrollAffordances)
    })
    let suggestionLoading = $state(false)
    let replySuggestions = $state<string[]>([])
    const userTemplate = '{{user}}'
    const generationTimeoutMs = 180_000

    // Side drawer for other chats of this character
    let chatDrawerOpen = $state(false)
    let characterChats = $state<ChatSummary[]>([])
    let loadingCharacterChats = $state(false)

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }

    async function openChatDrawer() {
        chatDrawerOpen = true
        if (!char) return
        loadingCharacterChats = true
        try {
            const res = await api.chats.list({ characterId: char.id, pageSize: 50 })
            characterChats = res.items
        } catch (error) {
            toasts.error(error)
        } finally {
            loadingCharacterChats = false
        }
    }

    async function startNewChat() {
        if (!char) return
        try {
            const newChat = await api.chats.create({ characterId: char.id })
            chatDrawerOpen = false
            router.go(`/chat/${newChat.id}`)
        } catch (error) {
            toasts.error(error)
        }
    }

    async function removeDrawerChat(id: string) {
        if (!confirm('이 대화를 삭제할까요?')) return
        try {
            await api.chats.remove(id)
            characterChats = characterChats.filter((c) => c.id !== id)
            toasts.success('대화를 삭제했습니다.')
            if (id === chatId) {
                if (characterChats.length) {
                    router.go(`/chat/${characterChats[0].id}`)
                } else {
                    router.go(`/c/${char?.slug ?? ''}`)
                }
            }
        } catch (error) {
            toasts.error(error)
        }
    }

    onMount(async () => {
        try {
            chat = await api.chats.detail(chatId, { limit: 1000 })
            char = await api.characters.detail(chat.characterId)
            personas = await api.personas.list()
            activePersona =
                personas.find((item) => item.id === chat?.personaId) ??
                personas.find((item) => item.isDefault) ??
                null

            await loadChatIntoEngine(char, chat)
            if (activePersona) setEnginePersona(activePersona)
            const rawGreetings = [
                typeof char.card.firstMessage === 'string' ? char.card.firstMessage : '',
                ...(Array.isArray(char.card.alternateGreetings)
                    ? char.card.alternateGreetings.map((item) => String(item))
                    : []),
            ]
            greetingOptions = char.greetings
                .map((option) => ({ ...option, content: rawGreetings[option.index] ?? '' }))
                .filter((option) => option.content)
            const activeGreeting = greetingOptions.findIndex(
                (option) => option.content === chat?.messages[0]?.content,
            )
            greetingPosition = activeGreeting
            messages = readEngineMessages()
            failedUserMessageIndex = messages.at(-1)?.role === 'user' ? messages.length - 1 : null
            void api.me.usage().then((u) => {
                if (u) {
                    engineState.usageQuota = u.quota
                    if (u.lastModel && !engineState.lastRoutedVia) engineState.lastRoutedVia = u.lastModel
                }
            }).catch(() => {})
        } catch (error) {
            toasts.error(error)
        } finally {
            loading = false
        }
    })

    let pendingScrollTimer: any = null
    let activeScrollTarget: 'top' | 'bottom' | null = null

    function cancelPendingScroll() {
        if (pendingScrollTimer) {
            clearTimeout(pendingScrollTimer)
            pendingScrollTimer = null
        }
        activeScrollTarget = null
    }

    function isNearBottom(threshold = 160): boolean {
        if (!scroller) return true
        return (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= threshold
    }

    /**
     * Which quick-scroll arrows are worth showing.
     *
     * The paddle floats over the right edge of the text column, so a button that
     * cannot do anything — "to top" while already at the top — is pure occlusion.
     * Each arrow appears only once there is somewhere to go, and a conversation
     * short enough to fit on screen shows none at all.
     */
    let canScrollUp = $state(false)
    let canScrollDown = $state(false)

    function refreshScrollAffordances() {
        const el = scroller
        if (!el) return
        const slack = 24
        const scrollable = el.scrollHeight - el.clientHeight > slack * 2
        canScrollUp = scrollable && el.scrollTop > slack
        canScrollDown = scrollable && el.scrollHeight - el.scrollTop - el.clientHeight > slack
    }

    function scrollToEdge(edge: 'top' | 'bottom', smooth = true) {
        if (!scroller) return
        cancelPendingScroll()
        activeScrollTarget = edge

        if (edge === 'top') {
            scroller.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
            return
        }

        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })

        pendingScrollTimer = setTimeout(() => {
            if (activeScrollTarget === 'bottom' && scroller) {
                scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' })
            }
            pendingScrollTimer = null
            activeScrollTarget = null
        }, 160)
    }

    function handleScrollPaddle(event: MouseEvent | TouchEvent, edge: 'top' | 'bottom') {
        scrollToEdge(edge, true)
        if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.blur()
        }
    }

    function cardText(key: string): string {
        const value = char?.card?.[key]
        return typeof value === 'string' ? value : ''
    }

    async function generateReplySuggestions() {
        if (!char || !session.gatewayToken || suggestionLoading || engineState.generating) return
        suggestionLoading = true
        suggestionMenuOpen = false
        replySuggestions = []
        try {
            const rawContext = messages.slice(-20).map((message) => ({
                role: message.role === 'char' ? 'assistant' as const : 'user' as const,
                content: message.data.slice(0, 4000),
            }))
            const context = rawContext.length > 0 && rawContext[0].role === 'assistant'
                ? [{ role: 'user' as const, content: '(대화를 시작합니다.)' }, ...rawContext]
                : rawContext

            const characterContext = [
                `이름: ${char.name}`,
                `설명: ${char.description}`,
                `성격: ${cardText('personality')}`,
                `상황: ${cardText('scenario')}`,
            ].filter((line) => !line.endsWith(': ')).join('\n')
            const personaContext = activePersona
                ? `유저 페르소나 이름: ${activePersona.name}\n유저 페르소나 설명: ${activePersona.prompt}`
                : '유저 페르소나 정보 없음'
            const raw = await api.gateway.complete(session.gatewayToken, {
                model: appConfig.config?.generation.modelAlias || 'auto',
                temperature: 0.85,
                max_tokens: 1500,
                messages: [
                    {
                        role: 'system',
                        content: `당신은 롤플레잉 채팅에서 다음에 유저가 보낼 답변 후보를 작성하는 어시스턴트입니다.\n현재 대화 흐름과 캐릭터 및 유저 페르소나 설정을 고려하여, 서로 분위기와 태도가 다른 자연스러운 유저 답변 후보 3개를 작성하세요.\n\n규칙:\n1. 각 후보는 유저(1인칭)의 대사와 행동/심리 묘사만 포함해야 합니다. 캐릭터의 대사를 대신 쓰거나 해설을 붙이지 마세요.\n2. 생각 과정(<think>), 번호, 부연 설명, 마크다운 없이 오직 JSON 문자열 배열 형식으로만 출력하세요.\n\n출력 예시:\n["답변 후보 1", "답변 후보 2", "답변 후보 3"]\n\n<character>\n${characterContext}\n</character>\n<persona>\n${personaContext}\n</persona>`,
                    },
                    ...context,
                    {
                        role: 'user',
                        content: '지금 대화 흐름에 이어 유저가 보낼 수 있는 답변 후보 3개를 JSON 문자열 배열(["답변1", "답변2", "답변3"]) 형식으로 제안해 주세요.',
                    },
                ],
            })
            const suggestions = parseReplySuggestions(raw)
            if (suggestions.length === 0) throw new Error('추천 답변을 구성하지 못했습니다. 다시 시도해 주세요.')
            replySuggestions = suggestions
            const usage = await api.me.usage().catch(() => null)
            if (usage) engineState.usageQuota = usage.quota
        } catch (error) {
            toasts.error(error)
        } finally {
            suggestionLoading = false
        }
    }

    function selectReplySuggestion(suggestion: string) {
        text = suggestion
        replySuggestions = []
    }

    async function send() {
        const value = text.trim()
        if (!value || engineState.generating) return
        text = ''
        replySuggestions = []
        suggestionMenuOpen = false
        failedUserMessageIndex = null
        const userMessageIndex = appendEngineUserMessage(value)
        messages = [...readEngineMessages()]
        // Persist the user's turn before generation. Even if every model
        // fails or the page closes mid-request, their message remains.
        try {
            await syncChat(true)
        } catch (error) {
            failedUserMessageIndex = userMessageIndex
            toasts.error(error)
            return
        }
        try {
            await generateAfterUserMessage(userMessageIndex)
        } catch (error) {
            toasts.error(error)
        }
    }

    async function generateAfterUserMessage(userMessageIndex: number) {
        if (engineState.generating) return
        failedUserMessageIndex = null
        try {
            const currentHandle = generate({
                onTick: (current) => {
                    messages = [...current]
                },
            })
            handle = currentHandle
            let timeoutId: ReturnType<typeof setTimeout> | undefined
            const timeout = new Promise<boolean>((_, reject) => {
                timeoutId = setTimeout(() => {
                    currentHandle.abort()
                    reject(new Error('답변 생성 시간이 너무 길어 중단했습니다. 다시 시도해 주세요.'))
                }, generationTimeoutMs)
            })
            const completed = await Promise.race([currentHandle.done, timeout]).finally(() => {
                if (timeoutId) clearTimeout(timeoutId)
            })
            if (!completed) throw new Error('답변 생성이 중단되었습니다. 다시 시도해 주세요.')
            await syncChat(true)
            messages = [...readEngineMessages()]
            renderRevision++
        } catch (error) {
            discardEngineMessagesAfter(userMessageIndex)
            messages = [...readEngineMessages()]
            failedUserMessageIndex = userMessageIndex
            await syncChat(true).catch(() => {})
            throw error
        } finally {
            handle = null
        }
    }

    async function retryFailedMessage() {
        const index = failedUserMessageIndex
        if (index === null || engineState.generating) return
        try {
            await generateAfterUserMessage(index)
        } catch (error) {
            toasts.error(error)
        }
    }

    async function regenerate(index: number) {
        if (engineState.generating || index <= 0) return
        truncateForRegenerate(index)
        messages = readEngineMessages()
        try {
            handle = generate({
                onTick: (current) => {
                    messages = [...current]
                },
            })
            await handle.done
            await syncChat(true)
            messages = readEngineMessages()
            renderRevision++
        } catch (error) {
            toasts.error(error)
        } finally {
            handle = null
        }
    }

    async function switchGreeting(direction: -1 | 1) {
        if (
            !chat ||
            greetingOptions.length < 2 ||
            greetingPosition < 0 ||
            greetingSwitching ||
            engineState.generating
        )
            return
        const nextPosition = (greetingPosition + direction + greetingOptions.length) % greetingOptions.length
        const next = greetingOptions[nextPosition]
        greetingSwitching = true
        try {
            await api.chats.selectGreeting(chat.id, { greetingIndex: next.index })
            setEngineGreeting(next.index, next.content)
            messages = [...readEngineMessages()]
            greetingPosition = nextPosition
            renderRevision++
        } catch (error) {
            toasts.error(error)
        } finally {
            greetingSwitching = false
        }
    }

    function key(event: KeyboardEvent) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
        }
    }

    function remove(index: number) {
        deleteEngineMessage(index)
        messages = readEngineMessages()
        renderRevision++
    }

    async function handleRisuControl(event: MouseEvent) {
        const target = event.target
        if (!(target instanceof Element)) return
        const origin = target.closest('[risu-trigger], [risu-btn]')
        if (!origin) return

        try {
            event.preventDefault()
            if (!(await activateEngineControl(origin))) return
            messages = [...readEngineMessages()]
            renderRevision++
            await syncChat(true)
        } catch (error) {
            toasts.error(error)
        }
    }

    function generationStatus() {
        return (
            [
                '답장을 준비하는 중…',
                '대화를 읽는 중…',
                '기억을 정리하는 중…',
                '모델을 찾는 중…',
                '답장을 다듬는 중…',
            ][engineState.processStage] ?? '답장을 쓰는 중…'
        )
    }

    function formatGeneratedAt(time?: number) {
        if (!time) return '생성일 미상'
        const timestamp = time < 10_000_000_000 ? time * 1000 : time
        const date = new Date(timestamp)
        if (Number.isNaN(date.getTime())) return '생성일 미상'
        return date.toLocaleString('ko-KR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        })
    }

    function messageModel(message: EngineChatMessage) {
        let m = message.model ?? message.generationInfo?.model
        if (!m || m === 'omniroute/auto' || m === 'auto' || m === 'omniroute') {
            if (engineState.lastRoutedVia && engineState.lastRoutedVia !== 'omniroute/auto' && engineState.lastRoutedVia !== 'auto' && engineState.lastRoutedVia !== 'omniroute') {
                m = engineState.lastRoutedVia
            }
        }
        if (!m || m === 'omniroute/auto' || m === 'auto' || m === 'omniroute') {
            m = appConfig.config?.generation.modelAlias || 'AI Model'
        }
        if (m.startsWith('omniroute/')) {
            m = m.slice(10)
        }
        return m
    }

    async function toggleUsage() {
        usageOpen = !usageOpen
        if (!usageOpen) return

        usageLoading = true
        try {
            const status = await api.me.usage()
            engineState.usageQuota = status.quota
            if (!engineState.lastRoutedVia) engineState.lastRoutedVia = status.lastModel
        } catch (error) {
            toasts.error(error)
        } finally {
            usageLoading = false
        }
    }

    function resetLabel(resetAt: string | null) {
        if (!resetAt) return '사용을 시작하면 초기화 시간이 표시됩니다.'
        const date = new Date(resetAt)
        if (Number.isNaN(date.getTime())) return ''
        return `${date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 초기화`
    }

    function openPersonaEditor() {
        if (!activePersona) return
        personaName = activePersona.name
        personaPrompt = activePersona.prompt
        personaAvatar = null
        personaEditorOpen = true
        usageOpen = false
    }

    function closePersonaEditor() {
        if (personaSaving) return
        personaEditorOpen = false
        personaAvatar = null
    }

    async function savePersona(event: SubmitEvent) {
        event.preventDefault()
        if (!activePersona || !personaName.trim() || personaSaving) return

        personaSaving = true
        try {
            let updated = await api.personas.update(activePersona.id, {
                name: personaName.trim(),
                prompt: personaPrompt,
            })
            if (personaAvatar) {
                updated = await api.personas.setAvatar(activePersona.id, personaAvatar)
            }

            personas = personas.map((persona) => persona.id === updated.id ? updated : persona)
            activePersona = updated
            setEnginePersona(updated)
            personaEditorOpen = false
            personaAvatar = null
            renderRevision++
            toasts.success('유저 페르소나를 저장했습니다.')
        } catch (error) {
            toasts.error(error)
        } finally {
            personaSaving = false
        }
    }

    function handleComposerFocus() {
        setTimeout(() => {
            if (scroller && isNearBottom(300)) {
                scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
            }
        }, 300)
    }

    function handleWindowKeydown(event: KeyboardEvent) {
        if (personaEditorOpen && event.key === 'Escape') closePersonaEditor()
        if (usageOpen && event.key === 'Escape') usageOpen = false
        if (chatDrawerOpen && event.key === 'Escape') chatDrawerOpen = false
        if (suggestionMenuOpen && event.key === 'Escape') suggestionMenuOpen = false
    }
</script>

<svelte:window onkeydown={handleWindowKeydown} ondragstart={preventMobileDrag} />

{#if loading}
    <div class="grid h-full place-items-center text-kai-faint">대화를 불러오는 중…</div>
{:else if chat && char}
    <div
        class="kai-chat-layout kai-mobile-drag-guard"
        onclickcapture={handleRisuControl}
    >
        <section class="kai-chat-conversation">
            <div class="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
                <BackgroundDom />
            </div>
            <header class="kai-chat-topbar relative z-30">
                <button class="kai-icon-action" aria-label="뒤로" onclick={() => router.back()}><ArrowLeft size={21} /></button>
                {#if char.avatarUrl}
                    <img src={char.avatarUrl} alt="" class="h-10 w-10 shrink-0 rounded-full object-cover" />
                {/if}
                <div class="min-w-0">
                    <h1 class="truncate font-bold">{char.name}</h1>
                    <p class="text-[11px] text-kai-faint">
                        {engineState.generating ? generationStatus() : '대화 중'}
                    </p>
                </div>
                <div class="relative ml-auto flex items-center gap-1.5">
                </div>
                <button
                    class="kai-btn kai-btn-ghost h-9 px-3 text-xs"
                    aria-label="유저 페르소나 편집"
                    onclick={openPersonaEditor}
                    disabled={!activePersona || engineState.generating}
                >
                    <UserRoundPen size={16} aria-hidden="true" />
                    <span class="hidden sm:inline">내 페르소나</span>
                </button>
                <button type="button" class="kai-icon-action" aria-label="다른 대화 목록" onclick={openChatDrawer}><List size={20} /></button>
            </header>

            <div class="relative min-h-0 flex-1">
                <div
                    class="kai-chat-messages kai-scroll h-full"
                    bind:this={scroller}
                    onscroll={refreshScrollAffordances}
                    onpointerdown={cancelPendingScroll}
                    ontouchstart={cancelPendingScroll}
                    onwheel={cancelPendingScroll}
                >
                    <div class="mx-auto max-w-2xl space-y-5">
                    {#if char.creatorNotes.trim()}
                        <aside
                            class="rounded-2xl border border-kai-border-soft bg-kai-surface/80 p-4 shadow-sm"
                            data-kai-creator-notes
                        >
                            <p class="mb-3 text-[11px] font-bold tracking-[.12em] text-kai-faint">
                                제작자 코멘트
                            </p>
                            <MultiLangText value={char.creatorNotes} />
                        </aside>
                    {/if}
                    {#each messages as message, index}
                        <!--
                            Reading layout: every turn is a full-width passage with a
                            byline, the way a novel reads, instead of a pair of chat
                            bubbles. The speaker is carried by the byline, so the text
                            itself needs no alignment or colour to be attributable.
                        -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <article
                            class="kai-turn {message.role} group"
                            class:meta-open={openMetaIndex === index}
                            onclick={(event) => toggleTurnMeta(index, event)}
                        >
                            <div class="kai-turn-byline">
                                {#if message.role === 'char'}
                                    {#if char.avatarUrl}
                                        <img src={char.avatarUrl} alt="" class="kai-turn-avatar" />
                                    {/if}
                                    <span class="kai-turn-name">{char.name}</span>
                                {:else}
                                    {#if activePersona?.avatarUrl}
                                        <img src={activePersona.avatarUrl} alt="" class="kai-turn-avatar" />
                                    {/if}
                                    <span class="kai-turn-name">
                                        {activePersona?.name ?? session.user?.displayName ?? '나'}
                                    </span>
                                {/if}
                            </div>
                            <div class="min-w-0">
                                <div class="kai-message-bubble {message.role}">
                                    <ChatMessageBody
                                        message={message.data}
                                        role={message.role}
                                        {index}
                                        characterId={char.id}
                                        speakerName={message.role === 'user'
                                            ? (activePersona?.name ?? session.user?.displayName ?? 'User')
                                            : char.name}
                                        revision={renderRevision}
                                        streaming={engineState.generating &&
                                            index === messages.length - 1 &&
                                            message.role === 'char'}
                                    />
                                </div>
                                {#if index === 0 && message.role === 'char' && greetingOptions.length > 1 && greetingPosition >= 0}
                                    <div class="mt-2 flex w-fit max-w-full items-center gap-1 rounded-full border border-kai-border-soft bg-kai-surface/80 p-1 text-xs text-kai-dim shadow-sm">
                                        <button
                                            class="grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-kai-surface-2 hover:text-kai-text disabled:cursor-wait disabled:opacity-40"
                                            aria-label="이전 첫 장면"
                                            title="이전 첫 장면"
                                            disabled={greetingSwitching || engineState.generating}
                                            onclick={() => switchGreeting(-1)}
                                        ><ChevronLeft size={16} aria-hidden="true" /></button>
                                        <span class="max-w-52 truncate px-1" title={greetingOptions[greetingPosition]?.name}>
                                            {greetingOptions[greetingPosition]?.name}
                                            <span class="text-kai-faint">{greetingPosition + 1}/{greetingOptions.length}</span>
                                        </span>
                                        <button
                                            class="grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-kai-surface-2 hover:text-kai-text disabled:cursor-wait disabled:opacity-40"
                                            aria-label="다음 첫 장면"
                                            title="다음 첫 장면"
                                            disabled={greetingSwitching || engineState.generating}
                                            onclick={() => switchGreeting(1)}
                                        ><ChevronRight size={16} aria-hidden="true" /></button>
                                    </div>
                                {/if}
                                <div
                                    class="kai-turn-meta mt-1 flex items-center gap-2 px-1 text-[10px] leading-none text-kai-faint"
                                >
                                    {#if message.role === 'char'}
                                        <span>{formatGeneratedAt(message.time)}</span>
                                        {#if index !== 0}
                                            <span aria-hidden="true">·</span>
                                            <span class="max-w-56 truncate" title={messageModel(message)}>
                                                {messageModel(message)}
                                            </span>
                                        {/if}
                                    {:else}
                                        <span>나</span>
                                        {#if failedUserMessageIndex === index}
                                            <button
                                                type="button"
                                                class="grid h-6 w-6 place-items-center rounded-full border border-red-400/60 bg-red-500/10 text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-50"
                                                aria-label="답변 생성 재시도"
                                                title="답변 생성 재시도"
                                                onclick={retryFailedMessage}
                                                disabled={engineState.generating}
                                            ><CircleAlert size={16} aria-hidden="true" /></button>
                                        {/if}
                                    {/if}
                                    {#if appConfig.features?.regenerate && message.role === 'char' && index !== 0}
                                        <button
                                            class="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-kai-surface-2 hover:text-kai-text disabled:cursor-not-allowed disabled:opacity-40"
                                            aria-label="다른 답변"
                                            title="다른 답변"
                                            onclick={() => regenerate(index)}
                                            disabled={engineState.generating}
                                        >
                                            <RotateCcw size={13} aria-hidden="true" />
                                        </button>
                                    {/if}
                                    {#if appConfig.features?.deleteMessage}
                                        <button
                                            class="kai-turn-delete"
                                            aria-label="이 메시지 삭제"
                                            onclick={() => remove(index)}>삭제</button
                                        >
                                    {/if}
                                </div>
                            </div>
                        </article>
                    {/each}
                    {#if engineState.generating && messages.at(-1)?.role !== 'char'}
                        <div class="flex gap-1 px-4 py-3 text-kai-faint">
                            <span class="animate-pulse">●</span>
                            <span class="animate-pulse [animation-delay:150ms]">●</span>
                            <span class="animate-pulse [animation-delay:300ms]">●</span>
                        </div>
                    {/if}
                    </div>
                </div>

            </div>

            <div class="kai-chat-composer-dock">
                <div class="relative mx-auto max-w-2xl">
                    {#if replySuggestions.length}
                        <section class="mb-3 rounded-2xl border border-kai-border bg-kai-surface/95 p-3 shadow-xl backdrop-blur" aria-label="추천 답변">
                            <div class="mb-2 flex items-center justify-between px-1">
                                <div>
                                    <p class="text-xs font-bold text-kai-text">추천 답변</p>
                                    <p class="mt-0.5 text-[10px] text-kai-faint">선택하면 입력창에 채워집니다.</p>
                                </div>
                                <button
                                    type="button"
                                    class="kai-composer-scroll-action"
                                    aria-label="추천 답변 닫기"
                                    onclick={() => replySuggestions = []}
                                ><X size={16} aria-hidden="true" /></button>
                            </div>
                            <div class="grid gap-2">
                                {#each replySuggestions as suggestion, index}
                                    <button
                                        type="button"
                                        class="rounded-xl border border-kai-border-soft bg-kai-surface-2 px-4 py-3 text-left text-sm leading-6 text-kai-text transition-colors hover:border-kai-border hover:bg-kai-surface-3"
                                        aria-label={`추천 답변 ${index + 1} 선택`}
                                        onclick={() => selectReplySuggestion(suggestion)}
                                    >{suggestion}</button>
                                {/each}
                            </div>
                        </section>
                    {/if}
                    {#if suggestionMenuOpen}
                        <div class="absolute right-0 bottom-[calc(100%+0.75rem)] z-30 w-56 rounded-2xl border border-kai-border bg-kai-surface p-4 shadow-2xl">
                            <div class="flex items-start gap-3">
                                <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-kai-accent-soft text-kai-accent"><WandSparkles size={18} aria-hidden="true" /></span>
                                <div>
                                    <p class="text-sm font-bold text-kai-text">답변 추천</p>
                                    <p class="mt-1 text-[11px] leading-4 text-kai-faint">AI가 유저측 답변 3개를 제안합니다.</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                class="kai-btn kai-btn-primary mt-4 h-10 w-full text-sm"
                                onclick={generateReplySuggestions}
                            >생성하기</button>
                        </div>
                    {/if}
                    <div class="kai-chat-composer">
                        <textarea
                            class="kai-composer-input flex-1 resize-none bg-transparent px-2 py-2 text-base text-[16px] outline-none"
                            bind:this={inputEl}
                            bind:value={text}
                            oninput={autoGrow}
                            onkeydown={key}
                            onfocus={handleComposerFocus}
                            placeholder={`${char.name}에게 말하기`}
                            aria-label={`${char.name}에게 보낼 메시지`}
                            rows="1"
                            disabled={engineState.generating}
                        ></textarea>
                        <div class="flex shrink-0 gap-1 self-center">
                            <button
                                type="button"
                                class="kai-composer-scroll-action"
                                class:text-kai-accent={suggestionMenuOpen || suggestionLoading}
                                aria-label="추천 답변 생성"
                                aria-expanded={suggestionMenuOpen}
                                title="추천 답변"
                                disabled={engineState.generating || suggestionLoading || !session.gatewayToken}
                                onclick={() => suggestionMenuOpen = !suggestionMenuOpen}
                            >{#if suggestionLoading}<LoaderCircle class="animate-spin" size={17} aria-hidden="true" />{:else}<WandSparkles size={17} aria-hidden="true" />{/if}</button>
                        </div>
                        {#if engineState.generating}
                            <button class="kai-composer-action stop" aria-label="생성 정지" onclick={() => handle?.abort()}><Square size={17} fill="currentColor" /></button>
                        {:else}
                            <button class="kai-composer-action" aria-label="메시지 전송" onclick={send} disabled={!text.trim()}><Send size={18} /></button>
                        {/if}
                    </div>

                    <!--
                        The model picker lives under the composer rather than in the
                        top bar: on a phone the bar already carries back / avatar /
                        title / usage / persona / chat-list, and a label-bearing
                        button there pushed the title out of the row.
                    -->
                    <div class="kai-composer-toolbar">
                        <!--
                            The jump arrows used to float over the message column,
                            which is exactly where the prose is on a phone. They sit
                            in the control row instead, and each one only exists
                            while it has somewhere to go.
                        -->
                        <div class="kai-composer-jump">
                            {#if canScrollUp}
                                <button
                                    type="button"
                                    class="kai-composer-jump-btn"
                                    aria-label="맨 위로 이동"
                                    title="맨 위로"
                                    onclick={(event) => handleScrollPaddle(event, 'top')}
                                ><ArrowUp size={16} aria-hidden="true" /></button>
                            {/if}
                            {#if canScrollDown}
                                <button
                                    type="button"
                                    class="kai-composer-jump-btn"
                                    aria-label="맨 아래로 이동"
                                    title="맨 아래로"
                                    onclick={(event) => handleScrollPaddle(event, 'bottom')}
                                ><ArrowDown size={16} aria-hidden="true" /></button>
                            {/if}
                        </div>
                    </div>
                </div>
            </div>
        </section>

        {#if personaEditorOpen && activePersona}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
                role="presentation"
                onclick={(event) => {
                    if (event.target === event.currentTarget) closePersonaEditor()
                }}
            >
                <div
                    class="w-full max-w-lg rounded-2xl border border-kai-border bg-kai-surface p-5 shadow-2xl sm:p-6"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="persona-editor-title"
                >
                <form onsubmit={savePersona}>
                    <div class="flex items-start gap-4">
                        <div class="min-w-0 flex-1">
                            <p class="kai-eyebrow">대화 속의 나</p>
                            <h2 id="persona-editor-title" class="mt-1 text-xl font-black">유저 페르소나 편집</h2>
                        </div>
                        <button
                            type="button"
                            class="kai-icon-action"
                            aria-label="닫기"
                            onclick={closePersonaEditor}
                            disabled={personaSaving}
                        ><X size={19} /></button>
                    </div>

                    <div class="mt-6 grid gap-4">
                        <label class="grid gap-2 text-xs font-bold text-kai-dim">
                            프로필 이미지
                            <span class="flex items-center gap-4 rounded-xl bg-kai-surface-2 p-3">
                                {#if activePersona.avatarUrl}
                                    <img src={activePersona.avatarUrl} alt="" class="h-14 w-14 rounded-full object-cover" />
                                {:else}
                                    <span class="grid h-14 w-14 place-items-center rounded-full bg-kai-bg text-lg font-black text-kai-faint">
                                        {activePersona.name.slice(0, 1)}
                                    </span>
                                {/if}
                                <span class="min-w-0 flex-1 font-normal text-kai-faint">
                                    {personaAvatar?.name ?? 'PNG, JPG 또는 WebP 이미지를 선택하세요.'}
                                </span>
                                <span class="kai-btn kai-btn-ghost pointer-events-none h-9 px-3 text-xs"><ImageUp size={15} /> 선택</span>
                            </span>
                            <input
                                class="sr-only"
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onchange={(event) => {
                                    personaAvatar = event.currentTarget.files?.[0] ?? null
                                }}
                            />
                        </label>

                        <label class="grid gap-2 text-xs font-bold text-kai-dim">
                            이름
                            <input class="kai-input" bind:value={personaName} maxlength="80" required />
                        </label>

                        <label class="grid gap-2 text-xs font-bold text-kai-dim">
                            페르소나 설명
                            <textarea
                                class="kai-input min-h-40 resize-y"
                                bind:value={personaPrompt}
                                placeholder={`캐릭터가 ${userTemplate}를 이해할 수 있도록 성격, 말투, 배경 등을 적어주세요.`}
                            ></textarea>
                        </label>
                    </div>

                    <div class="mt-6 flex justify-end gap-2">
                        <button type="button" class="kai-btn kai-btn-ghost" onclick={closePersonaEditor} disabled={personaSaving}>취소</button>
                        <button class="kai-btn kai-btn-primary" disabled={personaSaving || !personaName.trim()}>
                            {personaSaving ? '저장 중…' : '저장'}
                        </button>
                    </div>
                </form>
                </div>
            </div>
        {/if}

        {#if chatDrawerOpen}
            <div
                class="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm"
                role="presentation"
                onclick={(e) => e.target === e.currentTarget && (chatDrawerOpen = false)}
            >
                <div
                    class="flex h-full w-full max-w-sm flex-col border-l border-kai-border bg-kai-surface p-5 shadow-2xl"
                    role="dialog"
                    aria-modal="true"
                    aria-label="대화 목록"
                >
                    <header class="flex items-center justify-between border-b border-kai-border-soft pb-4">
                        <div>
                            <h2 class="text-base font-bold text-kai-text">{char.name} 대화 목록</h2>
                            <p class="text-xs text-kai-faint">총 {characterChats.length}개의 대화</p>
                        </div>
                        <button type="button" class="kai-icon-action" onclick={() => chatDrawerOpen = false} aria-label="닫기">
                            <X size={18} />
                        </button>
                    </header>

                    <div class="my-4">
                        <button
                            type="button"
                            class="kai-btn kai-btn-primary w-full justify-center gap-2 py-2.5 text-xs font-bold"
                            onclick={startNewChat}
                        >
                            <Plus size={16} /> + 새 대화 시작
                        </button>
                    </div>

                    <div class="flex-1 overflow-y-auto space-y-2.5 pr-1">
                        {#if loadingCharacterChats}
                            <p class="py-12 text-center text-xs text-kai-faint">대화 목록 불러오는 중…</p>
                        {:else if !characterChats.length}
                            <p class="py-12 text-center text-xs text-kai-faint">다른 대화가 없습니다.</p>
                        {:else}
                            {#each characterChats as otherChat}
                                <div
                                    class="group relative flex flex-col rounded-xl border p-3 transition-colors {otherChat.id === chatId ? 'border-kai-accent bg-kai-accent/10' : 'border-kai-border-soft bg-kai-surface-2 hover:border-kai-border'}"
                                >
                                    <div class="flex items-center justify-between gap-2">
                                        <button
                                            type="button"
                                            class="flex-1 text-left min-w-0"
                                            onclick={() => {
                                                chatDrawerOpen = false
                                                if (otherChat.id !== chatId) router.go(`/chat/${otherChat.id}`)
                                            }}
                                        >
                                            <div class="flex items-center gap-2">
                                                <h3 class="font-bold text-xs truncate text-kai-text">{otherChat.title || '새 대화'}</h3>
                                                {#if otherChat.id === chatId}
                                                    <span class="rounded bg-kai-accent px-1.5 py-0.5 text-[10px] font-bold text-white">현재</span>
                                                {/if}
                                            </div>
                                            <p class="mt-1 line-clamp-1 text-xs text-kai-dim">{otherChat.lastMessagePreview || '대화 내용 없음'}</p>
                                            <div class="mt-1.5 flex items-center gap-2 text-[10px] text-kai-faint">
                                                <span>메시지 {otherChat.messageCount}개</span>
                                                <span>·</span>
                                                <span>{new Date(otherChat.updatedAt).toLocaleDateString('ko-KR')}</span>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            class="kai-icon-action text-kai-faint hover:text-red-400"
                                            aria-label="삭제"
                                            title="대화 삭제"
                                            onclick={() => removeDrawerChat(otherChat.id)}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            {/each}
                        {/if}
                    </div>

                    <div class="mt-4 border-t border-kai-border-soft pt-3">
                        <a
                            href="/chats"
                            class="kai-btn kai-btn-ghost w-full justify-center text-xs text-kai-dim"
                            onclick={() => chatDrawerOpen = false}
                        >
                            전체 작품 대화함으로 이동
                        </a>
                    </div>
                </div>
            </div>
        {/if}
    </div>
{:else}
    <div class="grid h-full place-items-center">대화를 열 수 없습니다.</div>
{/if}
