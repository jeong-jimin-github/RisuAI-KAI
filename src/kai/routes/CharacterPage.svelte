<script lang="ts">
    import type { CharacterDetail } from '@kai/shared/contract'
    import { ArrowLeft, Heart, Image as ImageIcon, MessageCircle, MessagesSquare, Play, UserRound, X } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import MultiLangText from '../components/MultiLangText.svelte'
    import { extractImageUrlsFromCharacter } from '../lib/imageExtractor'
    import { router } from '../lib/router.svelte'
    import { session, toasts } from '../stores/app.svelte'

    let { idOrSlug }: { idOrSlug: string } = $props()
    let char = $state<CharacterDetail | null>(null)
    let loading = $state(true), starting = $state(false)
    let previewModalUrl = $state<string | null>(null)
    let showAllImages = $state(false)

    const cardText = (key: string) => {
        const value = char?.card?.[key]
        return typeof value === 'string' ? value.trim() : ''
    }
    const imageUrls = $derived(extractImageUrlsFromCharacter(char))
    const displayedImageUrls = $derived(showAllImages ? imageUrls : imageUrls.slice(0, 10))
    onMount(async () => { try { char = await api.characters.detail(idOrSlug) } catch (error) { toasts.error(error) } finally { loading = false } })

    async function start() {
        if (!char) return
        if (!session.signedIn) { router.go(`/login?next=${encodeURIComponent(location.pathname)}`); return }
        starting = true
        try { const chat = await api.chats.create({ characterId: char.id }); router.go(`/chat/${chat.id}`) }
        catch (error) { toasts.error(error); starting = false }
    }
    async function like() {
        if (!char) return
        if (!session.signedIn) { router.go('/login'); return }
        try { const result = char.liked ? await api.characters.unlike(char.id) : await api.characters.like(char.id); char = { ...char, ...result } }
        catch (error) { toasts.error(error) }
    }
    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }
</script>

<svelte:window ondragstart={preventMobileDrag} />

<svelte:head>
    <title>{char ? `${char.name} - RisuAI-KAI` : '작품 정보 - RisuAI-KAI'}</title>
    {#if char}
        <meta name="description" content={char.description || char.tagline || `${char.name} 캐릭터와 AI 대화를 시작해보세요.`} />
        <meta property="og:title" content={`${char.name} - RisuAI-KAI`} />
        <meta property="og:description" content={char.description || char.tagline || `${char.name} 캐릭터와 AI 대화를 시작해보세요.`} />
        {#if char.avatarUrl}
            <meta property="og:image" content={char.avatarUrl} />
            <meta name="twitter:image" content={char.avatarUrl} />
        {/if}
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={`${char.name} - RisuAI-KAI`} />
        <meta name="twitter:description" content={char.description || char.tagline || `${char.name} 캐릭터와 AI 대화를 시작해보세요.`} />
    {/if}
</svelte:head>

{#if loading}
    <div class="grid h-full place-items-center text-kai-faint">작품을 불러오는 중…</div>
{:else if char}
    <article class="kai-detail-page kai-mobile-drag-guard">
        <div class="kai-detail-ambient">{#if char.avatarUrl}<img src={char.avatarUrl} alt="" />{/if}</div>
        <div class="kai-detail-container">
            <button class="kai-detail-back" aria-label="뒤로" onclick={() => router.back()}><ArrowLeft size={20} /> 돌아가기</button>
            <div class="kai-detail-grid">
                <div class="kai-detail-media">
                    {#if char.avatarUrl}<img src={char.avatarUrl} alt={char.name} />{:else}<div>{char.name.slice(0, 1)}</div>{/if}
                </div>
                <div class="kai-detail-content">
                    <h1>{char.name}</h1>
                    <div class="kai-detail-creator"><UserRound size={15} /> {char.creatorName || 'RisuAI-KAI'}</div>
                    <div class="kai-detail-stats">
                        <span><Heart size={16} /> 북마크 {char.likeCount.toLocaleString()}</span>
                        <span><MessageCircle size={16} /> 대화 {char.chatCount.toLocaleString()}</span>
                        <span><MessagesSquare size={16} /> 메시지 {char.messageCount.toLocaleString()}</span>
                    </div>

                    <section class="kai-detail-section">
                        <h2>작품 설명</h2>
                        <MultiLangText value={char.description} class="kai-detail-description" />
                    </section>

                    {#if cardText('scenario')}
                        <section class="kai-detail-section">
                            <h2>이야기의 시작</h2>
                            <MultiLangText value={cardText('scenario')} class="kai-detail-description" />
                        </section>
                    {/if}

                    {#if cardText('personality')}
                        <section class="kai-detail-section">
                            <h2>캐릭터</h2>
                            <MultiLangText value={cardText('personality')} class="kai-detail-description" />
                        </section>
                    {/if}

                    <section class="kai-detail-section">
                        <h2>장르 & 태그</h2>
                        <div class="kai-detail-tags large">
                            {#each char.tags as tag}
                                <a href={`/explore?tag=${encodeURIComponent(tag)}`}>#{tag}</a>
                            {/each}
                        </div>
                    </section>

                    <div class="kai-detail-actions">
                        <button class="kai-btn kai-btn-primary kai-start-button" disabled={starting} onclick={start}><Play size={18} fill="currentColor" />{starting ? '여는 중…' : '대화 시작'}</button>
                        <button class="kai-btn kai-btn-ghost" aria-label="북마크" onclick={like}><Heart size={18} fill={char.liked ? 'currentColor' : 'none'} />{char.liked ? '북마크 해제' : '북마크'} {char.likeCount}</button>
                    </div>

                    {#if imageUrls.length > 0}
                        <section class="kai-detail-section kai-detail-preview-section mt-6">
                            <h2><ImageIcon size={18} class="inline mr-1" /> 이미지 미리보기 ({imageUrls.length})</h2>
                            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                                {#each displayedImageUrls as imgUrl}
                                    <button
                                        type="button"
                                        class="group relative aspect-square overflow-hidden rounded-xl border border-kai-border-soft bg-kai-surface-2 transition hover:border-kai-accent hover:shadow-md focus:outline-none"
                                        onclick={() => previewModalUrl = imgUrl}
                                        title="이미지 크게 보기"
                                    >
                                        <img
                                            src={imgUrl}
                                            alt="미리보기"
                                            class="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                                            loading="lazy"
                                        />
                                    </button>
                                {/each}
                            </div>
                            {#if imageUrls.length > 10}
                                <div class="mt-3 text-center">
                                    <button
                                        type="button"
                                        class="kai-btn kai-btn-ghost text-xs"
                                        onclick={() => showAllImages = !showAllImages}
                                    >
                                        {showAllImages ? '접기' : `전체 보기 (${imageUrls.length}개)`}
                                    </button>
                                </div>
                            {/if}
                        </section>
                    {/if}
                </div>
            </div>
        </div>
    </article>

    {#if previewModalUrl}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onclick={() => previewModalUrl = null}
            role="dialog"
            aria-modal="true"
        >
            <div class="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-kai-surface p-2 shadow-2xl" onclick={(e) => e.stopPropagation()}>
                <button
                    type="button"
                    class="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                    onclick={() => previewModalUrl = null}
                    aria-label="닫기"
                ><X size={18} /></button>
                <img src={previewModalUrl} alt="확대 미리보기" class="max-h-[85vh] max-w-full rounded-xl object-contain" />
            </div>
        </div>
    {/if}
{:else}
    <div class="grid h-full place-items-center">캐릭터를 찾을 수 없습니다.</div>
{/if}
