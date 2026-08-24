<script lang="ts">
    import type { ChatSummary } from '@kai/shared/contract'
    import { ArrowLeft, Check, ChevronRight, MessageCircle, Plus, Trash2 } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import { toasts } from '../stores/app.svelte'

    type ChatGroup = {
        characterId: string
        characterName: string
        characterAvatarUrl: string | null
        chats: ChatSummary[]
        messageCount: number
    }

    let chats = $state<ChatSummary[]>([])
    let loading = $state(true)
    let deleting = $state(false)
    let selectedCharacterId = $state<string | null>(null)
    let selectionMode = $state(false)
    let selectedIds = $state<string[]>([])

    const groups = $derived.by(() => {
        const grouped = new Map<string, ChatGroup>()
        for (const chat of chats) {
            const group = grouped.get(chat.characterId)
            if (group) {
                group.chats.push(chat)
                group.messageCount += chat.messageCount
            } else {
                grouped.set(chat.characterId, {
                    characterId: chat.characterId,
                    characterName: chat.characterName,
                    characterAvatarUrl: chat.characterAvatarUrl,
                    chats: [chat],
                    messageCount: chat.messageCount,
                })
            }
        }
        return [...grouped.values()]
    })
    const selectedGroup = $derived(groups.find((group) => group.characterId === selectedCharacterId) ?? null)

    onMount(load)

    async function load() {
        try {
            const first = await api.chats.list({ page: 1, pageSize: 100 })
            const pageCount = Math.ceil(first.total / first.pageSize)
            const rest = pageCount > 1
                ? await Promise.all(
                    Array.from({ length: pageCount - 1 }, (_, index) =>
                        api.chats.list({ page: index + 2, pageSize: 100 }),
                    ),
                )
                : []
            chats = [first, ...rest].flatMap((page) => page.items)
        } catch (error) {
            toasts.error(error)
        } finally {
            loading = false
        }
    }

    function resetPageScroll() {
        requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('[data-kai-route-scroll]')?.scrollTo({ top: 0 })
        })
    }

    function openGroup(characterId: string) {
        selectedCharacterId = characterId
        selectionMode = false
        selectedIds = []
        resetPageScroll()
    }

    function closeGroup() {
        selectedCharacterId = null
        selectionMode = false
        selectedIds = []
        resetPageScroll()
    }

    function toggleSelection(id: string) {
        selectedIds = selectedIds.includes(id)
            ? selectedIds.filter((selectedId) => selectedId !== id)
            : [...selectedIds, id]
    }

    function toggleSelectAll() {
        if (!selectedGroup) return
        selectedIds = selectedIds.length === selectedGroup.chats.length
            ? []
            : selectedGroup.chats.map((chat) => chat.id)
    }

    function cancelSelection() {
        selectionMode = false
        selectedIds = []
    }

    async function remove(id: string) {
        if (!confirm('이 대화를 삭제할까요?')) return
        try {
            await api.chats.remove(id)
            chats = chats.filter((chat) => chat.id !== id)
            selectedIds = selectedIds.filter((selectedId) => selectedId !== id)
            if (!chats.some((chat) => chat.characterId === selectedCharacterId)) closeGroup()
            toasts.success('대화를 삭제했습니다.')
        } catch (error) {
            toasts.error(error)
        }
    }

    async function removeSelected() {
        if (!selectedIds.length || deleting) return
        if (!confirm(`선택한 대화 ${selectedIds.length}개를 삭제할까요? 되돌릴 수 없습니다.`)) return
        deleting = true
        const targets = [...selectedIds]
        try {
            const results = await Promise.allSettled(targets.map((id) => api.chats.remove(id)))
            const deletedIds = targets.filter((_, index) => results[index].status === 'fulfilled')
            const failed = targets.length - deletedIds.length
            const deleted = new Set(deletedIds)
            chats = chats.filter((chat) => !deleted.has(chat.id))
            selectedIds = []
            if (!chats.some((chat) => chat.characterId === selectedCharacterId)) closeGroup()
            if (failed) toasts.error(`${failed}개 대화는 삭제하지 못했습니다.`)
            if (deletedIds.length) toasts.success(`${deletedIds.length}개 대화를 삭제했습니다.`)
        } finally {
            deleting = false
        }
    }

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }
</script>

<svelte:window ondragstart={preventMobileDrag} />

<div class="kai-page-container kai-list-page kai-chat-list-page kai-mobile-drag-guard">
    {#if selectedGroup}
        <header class="kai-chat-list-heading">
            <button class="kai-btn kai-btn-ghost" onclick={closeGroup}><ArrowLeft size={17} /> 작품 목록</button>
            <div class="kai-chat-list-heading-copy">
                <h1 class="kai-page-title">{selectedGroup.characterName}</h1>
                <p>{selectedGroup.chats.length.toLocaleString()}개의 대화</p>
            </div>
            {#if selectionMode}
                <button class="kai-btn kai-btn-ghost" onclick={toggleSelectAll}>
                    {selectedIds.length === selectedGroup.chats.length ? '전체 해제' : '전체 선택'}
                </button>
                <button class="kai-btn kai-btn-danger" disabled={!selectedIds.length || deleting} onclick={removeSelected}>
                    <Trash2 size={16} /> {deleting ? '삭제 중…' : `${selectedIds.length}개 삭제`}
                </button>
                <button class="kai-btn kai-btn-ghost" disabled={deleting} onclick={cancelSelection}>취소</button>
            {:else}
                <button class="kai-btn kai-btn-ghost" onclick={() => selectionMode = true}>선택</button>
            {/if}
        </header>
    {:else}
        <header class="kai-section-header">
            <div>
                <h1 class="kai-page-title">내 채팅</h1>
                {#if groups.length}<p class="kai-chat-list-summary">{groups.length.toLocaleString()}개 작품의 대화</p>{/if}
            </div>
            <a class="kai-btn kai-btn-primary" href="/explore"><Plus size={17} /> 새 대화</a>
        </header>
    {/if}

    {#if loading}
        <p class="py-24 text-center text-kai-faint">대화를 불러오는 중…</p>
    {:else if selectedGroup}
        <div class="kai-chat-list">
            {#each selectedGroup.chats as chat}
                <article class="kai-chat-row" class:selecting={selectionMode} class:selected={selectedIds.includes(chat.id)}>
                    {#if selectionMode}
                        <button
                            class="kai-chat-select"
                            class:selected={selectedIds.includes(chat.id)}
                            aria-label={`${chat.title || chat.characterName} 선택`}
                            aria-pressed={selectedIds.includes(chat.id)}
                            onclick={() => toggleSelection(chat.id)}
                        >{#if selectedIds.includes(chat.id)}<Check size={16} strokeWidth={3} />{/if}</button>
                    {/if}
                    <a class="kai-chat-row-link" href={`/chat/${chat.id}`}>
                        {#if chat.characterAvatarUrl}
                            <img src={chat.characterAvatarUrl} alt={chat.characterName} draggable="false" />
                        {:else}
                            <div class="kai-chat-avatar">{chat.characterName.slice(0, 1)}</div>
                        {/if}
                        <div class="min-w-0 flex-1">
                            <div class="kai-chat-title-row">
                                <h2>{chat.title || chat.characterName}</h2>
                                <time>{new Date(chat.updatedAt).toLocaleDateString('ko-KR')}</time>
                            </div>
                            <p>{chat.lastMessagePreview || '대화를 시작해보세요.'}</p>
                            <span><MessageCircle size={12} /> {chat.messageCount.toLocaleString()}개의 메시지</span>
                        </div>
                    </a>
                    {#if !selectionMode}
                        <button class="kai-row-delete" aria-label="대화 삭제" onclick={() => remove(chat.id)}><Trash2 size={17} /></button>
                    {/if}
                </article>
            {/each}
        </div>
    {:else if groups.length}
        <div class="kai-chat-list kai-chat-series-list">
            {#each groups as group}
                {@const latest = group.chats[0]}
                <article class="kai-chat-row kai-chat-series-row">
                    <button class="kai-chat-row-link" onclick={() => openGroup(group.characterId)}>
                        {#if group.characterAvatarUrl}
                            <img src={group.characterAvatarUrl} alt={group.characterName} draggable="false" />
                        {:else}
                            <div class="kai-chat-avatar">{group.characterName.slice(0, 1)}</div>
                        {/if}
                        <div class="min-w-0 flex-1 text-left">
                            <div class="kai-chat-title-row">
                                <h2>{group.characterName}</h2>
                                <time>{new Date(latest.updatedAt).toLocaleDateString('ko-KR')}</time>
                            </div>
                            <p>{latest.lastMessagePreview || '대화를 시작해보세요.'}</p>
                            <span><MessageCircle size={12} /> 대화 {group.chats.length.toLocaleString()}개 · 메시지 {group.messageCount.toLocaleString()}개</span>
                        </div>
                        <ChevronRight class="kai-chat-series-arrow" size={20} aria-hidden="true" />
                    </button>
                </article>
            {/each}
        </div>
    {:else}
        <div class="kai-empty-state">
            <div>
                <MessageCircle class="mx-auto mb-4 text-kai-faint" size={32} />
                <p class="text-lg font-semibold text-kai-text">아직 시작한 대화가 없습니다</p>
                <a href="/explore" class="kai-btn kai-btn-primary mt-5">캐릭터 만나기</a>
            </div>
        </div>
    {/if}
</div>
