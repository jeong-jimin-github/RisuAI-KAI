<script lang="ts">
    import type { CharacterSummary, ClientUsageStatus, Persona } from '@kai/shared/contract'
    import {
        Heart,
        ImageUp,
        Library,
        LogOut,
        Moon,
        Pencil,
        Plus,
        Sun,
        Trash2,
        UserRound,
        X,
    } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import CharacterTile from '../components/CharacterTile.svelte'
    import { router } from '../lib/router.svelte'
    import { appConfig, session, theme, toasts } from '../stores/app.svelte'

    let personas = $state<Persona[]>([])
    let createdWorks = $state<CharacterSummary[]>([])
    let createdTotal = $state(0)
    let createdPage = $state(1)
    let createdLoadingMore = $state(false)
    let bookmarkedWorks = $state<CharacterSummary[]>([])
    let usage = $state<ClientUsageStatus | null>(null)
    let loading = $state(true)
    let name = $state('')
    let prompt = $state('')
    let saving = $state(false)
    let avatarSaving = $state(false)
    let editingId = $state<string | null>(null)
    let editName = $state('')
    let editPrompt = $state('')
    let editAvatar = $state<File | null>(null)
    let editSaving = $state(false)

    onMount(async () => {
        try {
            const [personaResult, createdResult, bookmarkedResult, usageResult] = await Promise.all([
                api.personas.list(),
                api.characters.list({ mine: true, sort: 'newest', pageSize: 6 }),
                api.characters.list({ liked: true, sort: 'newest', pageSize: 12 }),
                api.me.usage(),
            ])
            personas = personaResult
            createdWorks = createdResult.items
            createdTotal = createdResult.total
            bookmarkedWorks = bookmarkedResult.items
            usage = usageResult
        } catch (error) {
            toasts.error(error)
        } finally {
            loading = false
        }
    })

    async function add(event: SubmitEvent) {
        event.preventDefault()
        saving = true
        try {
            personas = [...personas, await api.personas.create({ name, prompt })]
            name = ''
            prompt = ''
            toasts.success('페르소나를 만들었습니다.')
        } catch (error) {
            toasts.error(error)
        } finally {
            saving = false
        }
    }

    async function remove(id: string) {
        try {
            await api.personas.remove(id)
            personas = personas.filter((persona) => persona.id !== id)
            if (editingId === id) cancelEdit()
            toasts.success('페르소나를 삭제했습니다.')
        } catch (error) {
            toasts.error(error)
        }
    }

    function beginEdit(persona: Persona) {
        editingId = persona.id
        editName = persona.name
        editPrompt = persona.prompt
        editAvatar = null
    }

    function cancelEdit() {
        if (editSaving) return
        editingId = null
        editAvatar = null
    }

    async function saveEdit(event: SubmitEvent) {
        event.preventDefault()
        if (!editingId || !editName.trim() || editSaving) return
        editSaving = true
        try {
            let updated = await api.personas.update(editingId, {
                name: editName.trim(),
                prompt: editPrompt,
            })
            if (editAvatar) updated = await api.personas.setAvatar(editingId, editAvatar)
            personas = personas.map((persona) => persona.id === updated.id ? updated : persona)
            editingId = null
            editAvatar = null
            toasts.success('페르소나를 수정했습니다.')
        } catch (error) {
            toasts.error(error)
        } finally {
            editSaving = false
        }
    }

    async function changeProfileAvatar(event: Event) {
        const input = event.currentTarget as HTMLInputElement
        const file = input.files?.[0]
        if (!file) return
        avatarSaving = true
        try {
            session.user = await api.me.setAvatar(file)
            personas = await api.personas.list()
            toasts.success('프로필 이미지를 변경했습니다.')
        } catch (error) {
            toasts.error(error)
        } finally {
            avatarSaving = false
            input.value = ''
        }
    }

    async function logout() {
        await session.logout()
        router.go('/')
    }

    async function loadMoreCreated() {
        if (createdLoadingMore || createdWorks.length >= createdTotal) return
        createdLoadingMore = true
        try {
            const nextPage = createdPage + 1
            const result = await api.characters.list({
                mine: true,
                sort: 'newest',
                page: nextPage,
                pageSize: 6,
            })
            const known = new Set(createdWorks.map((character) => character.id))
            createdWorks = [
                ...createdWorks,
                ...result.items.filter((character) => !known.has(character.id)),
            ]
            createdTotal = result.total
            createdPage = nextPage
        } catch (error) {
            toasts.error(error)
        } finally {
            createdLoadingMore = false
        }
    }

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }
</script>

<svelte:window ondragstart={preventMobileDrag} />

<div class="kai-page-container kai-settings-page kai-mobile-drag-guard">
    <header class="kai-page-heading">
        <h1 class="kai-page-title">마이페이지</h1>
    </header>
    <div class="kai-settings-grid">
        <aside class="kai-settings-profile">
            <div class="kai-settings-avatar">
                {#if session.user?.avatarUrl}
                    <img src={session.user.avatarUrl} alt="{session.user.displayName} 프로필" />
                {:else}
                    <span>{session.user?.displayName.slice(0, 1)}</span>
                {/if}
            </div>
            <h2>{session.user?.displayName}</h2>
            <p>{session.user?.email}</p>
            <label class="kai-btn kai-btn-ghost mt-5 w-full cursor-pointer">
                <ImageUp size={16} /> {avatarSaving ? '업로드 중…' : '프로필 사진 변경'}
                <input
                    class="sr-only"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    disabled={avatarSaving}
                    onchange={changeProfileAvatar}
                />
            </label>
            <button class="kai-btn kai-btn-ghost mt-2 w-full" onclick={logout}><LogOut size={16} /> 로그아웃</button>
        </aside>

        <div class="space-y-4">
            <section class="kai-card kai-settings-card">
                <div><h2>화면 모드</h2><p>편안한 색상으로 이야기를 즐겨보세요.</p></div>
                <div class="kai-theme-options">
                    <button class:active={theme.mode === 'dark'} onclick={() => theme.set('dark')}><Moon size={18} /> 어둡게</button>
                    <button class:active={theme.mode === 'light'} onclick={() => theme.set('light')}><Sun size={18} /> 밝게</button>
                    <button class:active={theme.mode === 'system'} onclick={() => theme.set('system')}>시스템</button>
                </div>
            </section>

            <section class="kai-card kai-settings-card block!">
                <div><h2>채팅 기록</h2><p>이 계정에서 지금까지 생성한 요청과 토큰입니다.</p></div>
                {#if usage}
                    <div class="kai-usage-grid">
                        <div class="kai-usage-item">
                            <div><span>누적 요청</span><strong>{usage.lifetime.requests.toLocaleString()}회</strong></div>
                            <p>AI 답변 생성을 요청한 전체 횟수</p>
                        </div>
                        <div class="kai-usage-item">
                            <div><span>누적 토큰</span><strong>{usage.lifetime.totalTokens.toLocaleString()}</strong></div>
                            <p>입력 {usage.lifetime.inputTokens.toLocaleString()} · 출력 {usage.lifetime.outputTokens.toLocaleString()}</p>
                        </div>
                    </div>
                    <p class="kai-usage-model">최근 사용 모델 · {usage.lastModel ?? '아직 사용 기록이 없습니다.'}</p>
                {:else if loading}
                    <p class="kai-settings-loading">사용량을 불러오는 중…</p>
                {/if}
            </section>

            <section class="kai-card kai-settings-card block!">
                <div><h2>페르소나</h2><p>캐릭터가 대화 속의 나를 이해하는 방식입니다.</p></div>
                <div class="kai-persona-list">
                    {#each personas as persona}
                        <article>
                            <div class="kai-persona-avatar">
                                {#if persona.avatarUrl}<img src={persona.avatarUrl} alt="" />{:else}<UserRound size={18} />{/if}
                            </div>
                            <div class="kai-persona-copy">
                                <h3>{persona.name}{#if persona.isDefault}<span>기본</span>{/if}</h3>
                                <p>{persona.prompt || '설명 없음'}</p>
                            </div>
                            <div class="kai-persona-actions">
                                <button aria-label={`${persona.name} 편집`} onclick={() => beginEdit(persona)}><Pencil size={16} /></button>
                                <button aria-label={`${persona.name} 삭제`} onclick={() => remove(persona.id)}><Trash2 size={16} /></button>
                            </div>
                        </article>
                    {/each}
                </div>

                {#if editingId}
                    <form class="kai-persona-form kai-persona-edit-form" onsubmit={saveEdit}>
                        <div class="flex items-center justify-between gap-3">
                            <h3>페르소나 편집</h3>
                            <button type="button" class="kai-icon-action" aria-label="편집 취소" onclick={cancelEdit}><X size={17} /></button>
                        </div>
                        <label class="kai-field-label">페르소나 이름<input class="kai-input" bind:value={editName} required maxlength="80" /></label>
                        <label class="kai-field-label">설명<textarea class="kai-input min-h-28 resize-y" bind:value={editPrompt}></textarea></label>
                        <label class="kai-field-label">
                            프로필 이미지
                            <span class="kai-file-picker"><ImageUp size={16} /> {editAvatar?.name ?? 'PNG, JPG, GIF 또는 WebP 선택'}</span>
                            <input class="sr-only" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onchange={(event) => editAvatar = event.currentTarget.files?.[0] ?? null} />
                        </label>
                        <div class="flex gap-2">
                            <button class="kai-btn kai-btn-primary" disabled={editSaving || !editName.trim()}>{editSaving ? '저장 중…' : '변경사항 저장'}</button>
                            <button type="button" class="kai-btn kai-btn-ghost" onclick={cancelEdit} disabled={editSaving}>취소</button>
                        </div>
                    </form>
                {/if}

                <form class="kai-persona-form" onsubmit={add}>
                    <h3>새 페르소나</h3>
                    <label class="kai-field-label">페르소나 이름<input class="kai-input" bind:value={name} placeholder="불리고 싶은 이름" required /></label>
                    <label class="kai-field-label">설명<textarea class="kai-input min-h-28 resize-y" bind:value={prompt} placeholder="말투, 성격, 배경을 간단히 적어주세요."></textarea></label>
                    <button class="kai-btn kai-btn-primary" disabled={saving}><Plus size={16} /> 페르소나 추가</button>
                </form>
            </section>

            <section class="kai-card kai-settings-card block! kai-library-card">
                <div class="kai-library-heading"><div><h2>등록한 작품</h2><p>이 계정으로 등록한 캐릭터입니다.</p></div><Library size={20} /></div>
                {#if createdWorks.length}
                    <div class="kai-profile-work-grid">{#each createdWorks as character}<CharacterTile {character} variant="horizontal" />{/each}</div>
                    {#if createdWorks.length < createdTotal}
                        <button class="kai-btn kai-btn-ghost kai-library-more" disabled={createdLoadingMore} onclick={loadMoreCreated}>
                            {createdLoadingMore ? '불러오는 중…' : `더보기 · ${createdTotal - createdWorks.length}개 남음`}
                        </button>
                    {/if}
                {:else if !loading}<p class="kai-library-empty">아직 등록한 작품이 없습니다.</p>{/if}
            </section>

            <section class="kai-card kai-settings-card block! kai-library-card">
                <div class="kai-library-heading"><div><h2>북마크한 작품</h2><p>다시 만나고 싶은 캐릭터입니다.</p></div><Heart size={20} /></div>
                {#if bookmarkedWorks.length}
                    <div class="kai-profile-work-grid">{#each bookmarkedWorks as character}<CharacterTile {character} variant="horizontal" />{/each}</div>
                {:else if !loading}<p class="kai-library-empty">아직 북마크한 작품이 없습니다.</p>{/if}
            </section>
        </div>
    </div>
</div>
