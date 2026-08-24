<script lang="ts">
    import { onMount } from 'svelte'
    import { apiDelete, apiGet, apiPatch, apiUpload } from '../api/client'
    import { extractImageUrlsFromCharacter } from '../lib/imageExtractor'
    import { toasts } from '../stores/app.svelte'

    type EditorSection = 'basic' | 'images' | 'prompts' | 'greetings' | 'lore' | 'scripts' | 'raw'

    let {
        characterId,
        onclose,
        onsaved,
        ondeleted,
    }: {
        characterId: string
        onclose: () => void
        onsaved: () => void | Promise<void>
        ondeleted: () => void | Promise<void>
    } = $props()

    const sections: [EditorSection, string][] = [
        ['basic', '기본 정보'],
        ['images', '이미지 항목'],
        ['prompts', '프롬프트'],
        ['greetings', '첫 메시지'],
        ['lore', '로어북'],
        ['scripts', '스크립트'],
        ['raw', '전체 JSON'],
    ]

    let loading = $state(true)
    let saving = $state(false)
    let deleting = $state(false)
    let section = $state<EditorSection>('basic')
    let mainEl = $state<HTMLElement>()
    let row = $state<any>(null)
    let card = $state<Record<string, any>>({})
    let tagsText = $state('')
    let avatarFile = $state<File | null>(null)
    let newAssetFile = $state<File | null>(null)
    let newAssetRefKey = $state('')
    let uploadingAsset = $state(false)
    let regexJson = $state('[]')
    let triggerJson = $state('[]')
    let rawJson = $state('{}')
    let editorError = $state('')

    const extractedImages = $derived(extractImageUrlsFromCharacter({
        card,
        assets: row?.assets,
        avatarUrl: row?.avatarAssetId ? `/api/assets/${row.avatarAssetId}` : undefined,
        creatorNotes: row?.creatorNotes,
    }))

    onMount(load)

    async function load() {
        loading = true
        try {
            const detail = await apiGet<any>(`/admin/characters/${characterId}`)
            row = detail
            card = structuredClone(detail.card ?? {})
            normaliseCard()
            tagsText = (row.tags ?? card.tags ?? []).join(', ')
            refreshJsonEditors()
        } catch (error) {
            toasts.error(error)
            onclose()
        } finally {
            loading = false
        }
    }

    function normaliseCard() {
        const textFields = [
            'name', 'desc', 'personality', 'scenario', 'firstMessage', 'exampleMessage',
            'creatorNotes', 'systemPrompt', 'postHistoryInstructions', 'replaceGlobalNote',
            'additionalText', 'defaultVariables', 'backgroundHTML', 'creator', 'characterVersion',
        ]
        for (const key of textFields) card[key] = String(card[key] ?? '')
        card.alternateGreetings = Array.isArray(card.alternateGreetings) ? card.alternateGreetings.map(String) : []
        card.tags = Array.isArray(card.tags) ? card.tags.map(String) : []
        card.globalLore = Array.isArray(card.globalLore) ? card.globalLore.map((entry: any, index: number) => ({
            ...entry,
            key: String(entry?.key ?? ''),
            secondkey: String(entry?.secondkey ?? ''),
            insertorder: Number(entry?.insertorder ?? 100),
            comment: String(entry?.comment ?? ''),
            content: String(entry?.content ?? ''),
            mode: entry?.mode ?? 'normal',
            alwaysActive: !!entry?.alwaysActive,
            selective: !!entry?.selective,
            useRegex: !!entry?.useRegex,
            extentions: { risu_case_sensitive: !!entry?.extentions?.risu_case_sensitive, ...(entry?.extentions ?? {}) },
            id: entry?.id ?? `lore-${index}`,
        })) : []
        card.customscript = Array.isArray(card.customscript) ? card.customscript : []
        card.triggerscript = Array.isArray(card.triggerscript) ? card.triggerscript : []
        card.depth_prompt = card.depth_prompt && typeof card.depth_prompt === 'object'
            ? card.depth_prompt
            : { depth: 4, prompt: '' }
        card.loreSettings = card.loreSettings && typeof card.loreSettings === 'object'
            ? card.loreSettings
            : undefined
    }

    function refreshJsonEditors() {
        regexJson = JSON.stringify(card.customscript ?? [], null, 2)
        triggerJson = JSON.stringify(card.triggerscript ?? [], null, 2)
        rawJson = JSON.stringify(card, null, 2)
    }

    function parseArray(source: string, label: string) {
        let value: unknown
        try { value = JSON.parse(source) } catch { throw new Error(`${label} JSON 문법을 확인해 주세요.`) }
        if (!Array.isArray(value)) throw new Error(`${label}은 JSON 배열이어야 합니다.`)
        return value
    }

    function commitCurrentSection(): boolean {
        editorError = ''
        try {
            if (section === 'scripts') {
                card.customscript = parseArray(regexJson, '정규식 스크립트')
                card.triggerscript = parseArray(triggerJson, '트리거 스크립트')
            } else if (section === 'raw') {
                const parsed = JSON.parse(rawJson)
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('캐릭터 JSON은 객체여야 합니다.')
                }
                card = parsed
                normaliseCard()
                row.name = card.name
                row.creatorName = card.creator
                row.creatorNotes = card.creatorNotes
                tagsText = (card.tags ?? []).join(', ')
                regexJson = JSON.stringify(card.customscript ?? [], null, 2)
                triggerJson = JSON.stringify(card.triggerscript ?? [], null, 2)
            }
            return true
        } catch (error) {
            editorError = error instanceof Error ? error.message : String(error)
            return false
        }
    }

    function switchSection(next: EditorSection) {
        if (!commitCurrentSection()) return
        section = next
        if (mainEl) mainEl.scrollTop = 0
        if (next === 'scripts') {
            regexJson = JSON.stringify(card.customscript ?? [], null, 2)
            triggerJson = JSON.stringify(card.triggerscript ?? [], null, 2)
        } else if (next === 'raw') {
            rawJson = JSON.stringify(card, null, 2)
        }
    }

    function addGreeting() {
        card.alternateGreetings.push('')
    }

    function moveGreeting(index: number, delta: number) {
        const next = index + delta
        if (next < 0 || next >= card.alternateGreetings.length) return
        ;[card.alternateGreetings[index], card.alternateGreetings[next]] = [card.alternateGreetings[next], card.alternateGreetings[index]]
    }

    function addLore() {
        card.globalLore.push({
            key: '', secondkey: '', insertorder: 100, comment: '', content: '', mode: 'normal',
            alwaysActive: false, selective: false, useRegex: false,
            extentions: { risu_case_sensitive: false },
            id: crypto.randomUUID(),
        })
    }

    function enableLoreSettings() {
        card.loreSettings = { scanDepth: 5, tokenBudget: 1500, recursiveScanning: true, fullWordMatching: false }
    }

    async function uploadAsset() {
        if (!newAssetFile || uploadingAsset) return
        uploadingAsset = true
        try {
            const refKey = newAssetRefKey.trim() || newAssetFile.name
            const res = await apiUpload<any>(`/admin/characters/${characterId}/asset`, newAssetFile, { refKey })
            toasts.success(`이미지 에셋 '${res.refKey}' 업로드 완료`)
            newAssetFile = null
            newAssetRefKey = ''
            if (!row.assets) row.assets = {}
            row.assets[res.refKey] = res.url
        } catch (error) {
            toasts.error(error)
        } finally {
            uploadingAsset = false
        }
    }

    async function removeAsset(refKey: string) {
        if (!confirm(`'${refKey}' 이미지 에셋을 삭제할까요?`)) return
        try {
            await apiDelete(`/admin/characters/${characterId}/asset?refKey=${encodeURIComponent(refKey)}`)
            toasts.success('이미지 에셋을 삭제했습니다.')
            if (row.assets) delete row.assets[refKey]
        } catch (error) {
            toasts.error(error)
        }
    }

    function copyToClipboard(text: string) {
        navigator.clipboard.writeText(text)
        toasts.success('클립보드에 복사했습니다.')
    }

    async function save() {
        if (!row || !commitCurrentSection()) return
        saving = true
        try {
            const tags = tagsText.split(',').map((tag) => tag.trim()).filter(Boolean)
            const name = String(row.name ?? card.name ?? '').trim()
            if (!name) throw new Error('캐릭터 이름을 입력해 주세요.')
            card.name = name
            card.creator = String(row.creatorName ?? '')
            card.creatorNotes = String(row.creatorNotes ?? card.creatorNotes ?? '')
            card.tags = tags
            await apiPatch(`/admin/characters/${characterId}`, {
                name,
                tagline: String(row.tagline ?? ''),
                creatorName: String(row.creatorName ?? ''),
                creatorNotes: card.creatorNotes,
                visibility: row.visibility,
                featured: !!row.featured,
                nsfw: !!row.nsfw,
                sortOrder: Number(row.sortOrder ?? 0),
                tags,
                card,
            })
            if (avatarFile) {
                await apiUpload(`/admin/characters/${characterId}/avatar`, avatarFile)
                avatarFile = null
            }
            toasts.success('캐릭터를 저장했습니다.')
            await onsaved()
            onclose()
        } catch (error) {
            toasts.error(error)
        } finally {
            saving = false
        }
    }

    async function removeCharacter() {
        if (!row || !confirm(`“${row.name}” 캐릭터를 삭제할까요? 연결된 모든 대화와 메시지도 함께 삭제되며 되돌릴 수 없습니다.`)) return
        deleting = true
        try {
            await apiDelete(`/admin/characters/${characterId}`)
            toasts.success('캐릭터를 삭제했습니다.')
            await ondeleted()
            onclose()
        } catch (error) {
            toasts.error(error)
        } finally {
            deleting = false
        }
    }
</script>

<div class="fixed inset-0 z-50 flex flex-col bg-kai-bg" role="dialog" aria-modal="true" aria-label="캐릭터 편집">
    <header class="flex min-h-16 shrink-0 items-center gap-3 border-b border-kai-border-soft bg-kai-surface px-4 md:px-6">
        <button class="kai-btn kai-btn-ghost" onclick={onclose} disabled={saving || deleting}>← 목록</button>
        <div class="min-w-0 flex-1">
            <h2 class="truncate font-bold">{row?.name ?? '캐릭터 편집'}</h2>
            <p class="truncate text-xs text-kai-faint">RisuAI 카드 전체 설정</p>
        </div>
        <button class="kai-btn kai-btn-primary" onclick={save} disabled={loading || saving || deleting}>{saving ? '저장 중…' : '저장'}</button>
    </header>

    {#if loading}
        <div class="grid flex-1 place-items-center text-sm text-kai-faint">불러오는 중…</div>
    {:else}
        <div class="flex min-h-0 flex-1 flex-col md:flex-row">
            <nav class="kai-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-kai-border-soft bg-kai-surface p-2 md:w-48 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3">
                {#each sections as item}
                    <button class="shrink-0 rounded-xl px-3 py-2 text-left text-sm {section === item[0] ? 'bg-kai-accent-soft text-kai-text' : 'text-kai-dim hover:bg-kai-surface-2'}" onclick={() => switchSection(item[0])}>{item[1]}</button>
                {/each}
                <button class="kai-btn kai-btn-danger mt-auto hidden md:flex" onclick={removeCharacter} disabled={saving || deleting}>{deleting ? '삭제 중…' : '캐릭터 삭제'}</button>
            </nav>

            <main bind:this={mainEl} class="kai-scroll min-w-0 flex-1 overflow-y-auto p-4 md:p-7">
                <div class="mx-auto max-w-5xl">
                    {#if editorError}<p class="mb-4 rounded-xl bg-kai-danger/10 p-3 text-sm text-kai-danger">{editorError}</p>{/if}

                    {#if section === 'basic'}
                        <div class="grid gap-5 lg:grid-cols-[220px_1fr]">
                            <div class="kai-card p-4">
                                {#if row.avatarAssetId}<img src={`/api/assets/${row.avatarAssetId}`} alt="" class="aspect-[3/4] w-full rounded-xl object-cover"/>{:else}<div class="grid aspect-[3/4] place-items-center rounded-xl bg-kai-surface-2 text-sm text-kai-faint">이미지 없음</div>{/if}
                                <label class="mt-3 block text-sm">대표 이미지<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="mt-2 block w-full text-xs text-kai-dim" onchange={(event) => avatarFile = event.currentTarget.files?.[0] ?? null}/></label>
                            </div>
                            <div class="kai-card grid gap-4 p-5 sm:grid-cols-2">
                                <label class="block text-sm">이름<input class="kai-input mt-1" bind:value={row.name}/></label>
                                <label class="block text-sm">제작자<input class="kai-input mt-1" bind:value={row.creatorName}/></label>
                                <label class="block text-sm sm:col-span-2">한 줄 소개<input class="kai-input mt-1" bind:value={row.tagline}/></label>
                                <label class="block text-sm sm:col-span-2">태그 <span class="text-kai-faint">(쉼표로 구분)</span><input class="kai-input mt-1" bind:value={tagsText}/></label>
                                <label class="block text-sm">공개 상태<select class="kai-input mt-1" bind:value={row.visibility}><option value="public">공개</option><option value="private">비공개</option></select></label>
                                <label class="block text-sm">정렬 우선순위<input type="number" class="kai-input mt-1" bind:value={row.sortOrder}/></label>
                                <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={row.featured}/> 추천 캐릭터</label>
                                <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={row.nsfw}/> NSFW</label>
                            </div>
                        </div>
                    {:else if section === 'images'}
                        <div class="space-y-6">
                            <div class="kai-card p-5">
                                <h3 class="font-semibold mb-1">대표 이미지 (아바타)</h3>
                                <p class="text-xs text-kai-faint mb-4">작품 대표 썸네일 이미지입니다.</p>
                                <div class="flex flex-wrap items-center gap-5">
                                    <div class="h-32 w-24 overflow-hidden rounded-xl bg-kai-surface-2 border border-kai-border-soft">
                                        {#if row.avatarAssetId}
                                            <img src={`/api/assets/${row.avatarAssetId}`} alt="대표 이미지" class="h-full w-full object-cover" />
                                        {:else}
                                            <div class="grid h-full place-items-center text-xs text-kai-faint">이미지 없음</div>
                                        {/if}
                                    </div>
                                    <div class="space-y-2">
                                        <input
                                            type="file"
                                            accept="image/png,image/jpeg,image/gif,image/webp"
                                            class="block text-xs text-kai-dim"
                                            onchange={(e) => avatarFile = e.currentTarget.files?.[0] ?? null}
                                        />
                                        <p class="text-xs text-kai-faint">새 대표 이미지를 선택한 후 '저장' 버튼을 누르면 업데이트됩니다.</p>
                                    </div>
                                </div>
                            </div>

                            <div class="kai-card p-5">
                                <h3 class="font-semibold mb-1">새 이미지 에셋 등록</h3>
                                <p class="text-xs text-kai-faint mb-4">감정 표현, 배경, 삽화 등에 사용할 이미지 에셋을 업로드합니다.</p>
                                <div class="flex flex-wrap items-end gap-3">
                                    <label class="block text-xs">
                                        <span class="font-medium text-kai-dim">식별 키 (refKey)</span>
                                        <input class="kai-input mt-1 w-48 text-xs" bind:value={newAssetRefKey} placeholder="예: bg.jpg, happy.png" />
                                    </label>
                                    <label class="block text-xs">
                                        <span class="font-medium text-kai-dim">이미지 파일</span>
                                        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="kai-input mt-1 text-xs" onchange={(e) => newAssetFile = e.currentTarget.files?.[0] ?? null} />
                                    </label>
                                    <button type="button" class="kai-btn kai-btn-primary text-xs" disabled={!newAssetFile || uploadingAsset} onclick={uploadAsset}>
                                        {uploadingAsset ? '업로드 중…' : '에셋 업로드'}
                                    </button>
                                </div>
                            </div>

                            <div class="kai-card p-5">
                                <div class="mb-4">
                                    <h3 class="font-semibold">작품 이미지 항목 목록</h3>
                                    <p class="text-xs text-kai-faint">에셋으로 등록된 이미지 및 프롬프트에 포함된 이미지 URL 목록입니다.</p>
                                </div>

                                {#if Object.keys(row.assets || {}).length > 0}
                                    <h4 class="text-xs font-bold text-kai-dim mb-3">등록된 이미지 에셋 ({Object.keys(row.assets).length})</h4>
                                    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 mb-6">
                                        {#each Object.entries(row.assets) as [refKey, url]}
                                            <div class="flex items-center gap-3 rounded-xl border border-kai-border-soft bg-kai-surface-2 p-3">
                                                <img src={String(url)} alt={refKey} class="h-16 w-16 rounded-lg object-cover border border-kai-border-soft" />
                                                <div class="min-w-0 flex-1">
                                                    <p class="truncate font-semibold text-xs">{refKey}</p>
                                                    <p class="truncate text-[11px] text-kai-faint">{url}</p>
                                                    <div class="mt-2 flex flex-wrap gap-1.5">
                                                        <button type="button" class="kai-btn kai-btn-ghost text-[11px] px-2 py-0.5" onclick={() => copyToClipboard(String(url))}>URL 복사</button>
                                                        <button type="button" class="kai-btn kai-btn-ghost text-[11px] px-2 py-0.5" onclick={() => copyToClipboard(`![${refKey}](${url})`)}>Markdown 복사</button>
                                                        <button type="button" class="kai-btn kai-btn-danger text-[11px] px-2 py-0.5" onclick={() => removeAsset(refKey)}>삭제</button>
                                                    </div>
                                                </div>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}

                                <h4 class="text-xs font-bold text-kai-dim mb-3">전체 추출된 이미지 ({extractedImages.length})</h4>
                                {#if extractedImages.length === 0}
                                    <p class="py-6 text-center text-xs text-kai-faint">등록되었거나 프롬프트에 포함된 이미지가 없습니다.</p>
                                {:else}
                                    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                        {#each extractedImages as url}
                                            <div class="flex items-center gap-3 rounded-xl border border-kai-border-soft bg-kai-surface-2 p-3">
                                                <img src={url} alt="이미지" class="h-16 w-16 rounded-lg object-cover border border-kai-border-soft" />
                                                <div class="min-w-0 flex-1">
                                                    <p class="truncate text-xs font-mono text-kai-text" title={url}>{url}</p>
                                                    <div class="mt-2 flex flex-wrap gap-1.5">
                                                        <button type="button" class="kai-btn kai-btn-ghost text-[11px] px-2 py-0.5" onclick={() => copyToClipboard(url)}>URL 복사</button>
                                                        <button type="button" class="kai-btn kai-btn-ghost text-[11px] px-2 py-0.5" onclick={() => copyToClipboard(`![이미지](${url})`)}>Markdown 복사</button>
                                                    </div>
                                                </div>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {:else if section === 'prompts'}
                        <div class="space-y-5">
                            <div class="kai-card grid gap-4 p-5 sm:grid-cols-2">
                                <label class="block text-sm sm:col-span-2">설명 / Description<textarea class="kai-input mt-1 min-h-32" bind:value={card.desc}></textarea></label>
                                <label class="block text-sm">성격 / Personality<textarea class="kai-input mt-1 min-h-32" bind:value={card.personality}></textarea></label>
                                <label class="block text-sm">시나리오 / Scenario<textarea class="kai-input mt-1 min-h-32" bind:value={card.scenario}></textarea></label>
                                <label class="block text-sm sm:col-span-2">시스템 프롬프트<textarea class="kai-input mt-1 min-h-40 font-mono text-xs" bind:value={card.systemPrompt}></textarea></label>
                                <label class="block text-sm sm:col-span-2">글로벌 노트 대체 <span class="text-kai-faint">(&#123;&#123;original&#125;&#125; 사용 가능)</span><textarea class="kai-input mt-1 min-h-32 font-mono text-xs" bind:value={card.replaceGlobalNote}></textarea></label>
                                <label class="block text-sm sm:col-span-2">Post History Instructions<textarea class="kai-input mt-1 min-h-28 font-mono text-xs" bind:value={card.postHistoryInstructions}></textarea></label>
                                <label class="block text-sm sm:col-span-2">예시 대화<textarea class="kai-input mt-1 min-h-32" bind:value={card.exampleMessage}></textarea></label>
                                <label class="block text-sm sm:col-span-2">제작자 노트<textarea class="kai-input mt-1 min-h-24" bind:value={row.creatorNotes}></textarea></label>
                                <label class="block text-sm">추가 임베딩 텍스트<textarea class="kai-input mt-1 min-h-28" bind:value={card.additionalText}></textarea></label>
                                <label class="block text-sm">기본 변수<textarea class="kai-input mt-1 min-h-28 font-mono text-xs" bind:value={card.defaultVariables} placeholder="key=value"></textarea></label>
                            </div>
                            <div class="kai-card grid gap-4 p-5 sm:grid-cols-[140px_1fr]">
                                <h3 class="font-semibold sm:col-span-2">Depth Prompt</h3>
                                <label class="block text-sm">깊이<input type="number" min="0" class="kai-input mt-1" bind:value={card.depth_prompt.depth}/></label>
                                <label class="block text-sm">프롬프트<input class="kai-input mt-1" bind:value={card.depth_prompt.prompt}/></label>
                                <label class="block text-sm sm:col-span-2">배경 HTML<textarea class="kai-input mt-1 min-h-32 font-mono text-xs" bind:value={card.backgroundHTML}></textarea></label>
                            </div>
                        </div>
                    {:else if section === 'greetings'}
                        <div class="space-y-4">
                            <div class="kai-card p-5"><label class="block text-sm font-semibold">기본 첫 메시지<textarea class="kai-input mt-2 min-h-48" bind:value={card.firstMessage}></textarea></label></div>
                            <div class="flex items-center justify-between"><h3 class="font-semibold">대체 첫 메시지 ({card.alternateGreetings.length})</h3><button class="kai-btn kai-btn-ghost" onclick={addGreeting}>+ 추가</button></div>
                            {#each card.alternateGreetings as greeting, index}
                                <div class="kai-card p-4">
                                    <div class="mb-2 flex items-center gap-2"><b class="text-sm">대체 인사 {index + 1}</b><span class="flex-1"></span><button class="kai-btn kai-btn-ghost px-3" onclick={() => moveGreeting(index, -1)} disabled={index === 0}>↑</button><button class="kai-btn kai-btn-ghost px-3" onclick={() => moveGreeting(index, 1)} disabled={index === card.alternateGreetings.length - 1}>↓</button><button class="kai-btn kai-btn-danger px-3" onclick={() => card.alternateGreetings.splice(index, 1)}>삭제</button></div>
                                    <textarea class="kai-input min-h-40" bind:value={card.alternateGreetings[index]}></textarea>
                                </div>
                            {/each}
                            {#if !card.alternateGreetings.length}<p class="py-12 text-center text-sm text-kai-faint">대체 첫 메시지가 없습니다.</p>{/if}
                        </div>
                    {:else if section === 'lore'}
                        <div class="space-y-4">
                            <div class="kai-card p-5">
                                <div class="flex flex-wrap items-center gap-3"><div class="min-w-0 flex-1"><h3 class="font-semibold">로어북 설정</h3><p class="text-xs text-kai-faint">비워 두면 서비스 기본값을 사용합니다.</p></div><label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={card.lorePlus}/> LoreBook+ 형식</label>{#if card.loreSettings}<button class="kai-btn kai-btn-ghost" onclick={() => card.loreSettings = undefined}>기본값 사용</button>{:else}<button class="kai-btn kai-btn-ghost" onclick={enableLoreSettings}>캐릭터별 설정</button>{/if}</div>
                                {#if card.loreSettings}<div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><label class="block text-sm">검색 깊이<input type="number" min="0" max="20" class="kai-input mt-1" bind:value={card.loreSettings.scanDepth}/></label><label class="block text-sm">토큰 예산<input type="number" min="0" max="4096" class="kai-input mt-1" bind:value={card.loreSettings.tokenBudget}/></label><label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={card.loreSettings.recursiveScanning}/> 재귀 검색</label><label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={card.loreSettings.fullWordMatching}/> 단어 단위 일치</label></div>{/if}
                            </div>
                            <div class="flex items-center justify-between"><h3 class="font-semibold">항목 ({card.globalLore.length})</h3><button class="kai-btn kai-btn-primary" onclick={addLore}>+ 로어 추가</button></div>
                            {#each card.globalLore as lore, index}
                                <details class="kai-card p-4" open={card.globalLore.length < 4}>
                                    <summary class="cursor-pointer font-semibold">{lore.comment || lore.key || `로어 ${index + 1}`}</summary>
                                    <div class="mt-4 grid gap-4 sm:grid-cols-2">
                                        <label class="block text-sm">이름<input class="kai-input mt-1" bind:value={lore.comment}/></label>
                                        <label class="block text-sm">모드<select class="kai-input mt-1" bind:value={lore.mode}><option value="normal">일반</option><option value="constant">상시</option><option value="multiple">다중</option><option value="folder">폴더</option></select></label>
                                        <label class="block text-sm">활성화 키<input class="kai-input mt-1" bind:value={lore.key}/></label>
                                        <label class="block text-sm">보조 키<input class="kai-input mt-1" bind:value={lore.secondkey}/></label>
                                        <label class="block text-sm">삽입 순서<input type="number" min="0" max="1000" class="kai-input mt-1" bind:value={lore.insertorder}/></label>
                                        <label class="block text-sm">활성 확률 (%)<input type="number" min="0" max="100" class="kai-input mt-1" bind:value={lore.activationPercent} placeholder="100"/></label>
                                        <label class="block text-sm sm:col-span-2">프롬프트<textarea class="kai-input mt-1 min-h-40" bind:value={lore.content}></textarea></label>
                                        <div class="flex flex-wrap gap-4 text-sm sm:col-span-2"><label class="flex items-center gap-2"><input type="checkbox" bind:checked={lore.alwaysActive}/> 항상 활성</label><label class="flex items-center gap-2"><input type="checkbox" bind:checked={lore.selective}/> 선택적 키</label><label class="flex items-center gap-2"><input type="checkbox" bind:checked={lore.useRegex}/> 정규식 키</label><label class="flex items-center gap-2"><input type="checkbox" bind:checked={lore.extentions.risu_case_sensitive}/> 대소문자 구분</label></div>
                                        <div class="sm:col-span-2"><button class="kai-btn kai-btn-danger" onclick={() => card.globalLore.splice(index, 1)}>이 항목 삭제</button></div>
                                    </div>
                                </details>
                            {/each}
                            {#if !card.globalLore.length}<p class="py-12 text-center text-sm text-kai-faint">로어북 항목이 없습니다.</p>{/if}
                        </div>
                    {:else if section === 'scripts'}
                        <div class="space-y-5">
                            <div class="kai-card p-5"><h3 class="font-semibold">정규식 / 표시 스크립트</h3><p class="mt-1 text-xs text-kai-faint">RisuAI `customscript` 배열을 그대로 편집합니다.</p><textarea class="kai-input mt-3 min-h-80 font-mono text-xs" bind:value={regexJson} spellcheck="false"></textarea></div>
                            <div class="kai-card p-5"><h3 class="font-semibold">트리거 스크립트</h3><p class="mt-1 text-xs text-kai-faint">RisuAI `triggerscript` 배열을 그대로 편집합니다.</p><textarea class="kai-input mt-3 min-h-80 font-mono text-xs" bind:value={triggerJson} spellcheck="false"></textarea></div>
                        </div>
                    {:else if section === 'raw'}
                        <div class="kai-card p-5"><h3 class="font-semibold">RisuAI 캐릭터 전체 JSON</h3><p class="mt-1 text-sm text-kai-dim">위 화면에 없는 확장 필드·에셋 참조·고급 생성 데이터까지 모두 보존하고 직접 수정할 수 있습니다. 이 탭의 JSON이 유효해야 저장됩니다.</p><textarea class="kai-input mt-4 min-h-[65vh] font-mono text-xs" bind:value={rawJson} spellcheck="false"></textarea></div>
                    {/if}

                    <div class="mt-8 flex flex-wrap justify-end gap-2 border-t border-kai-border-soft pt-5">
                        <button class="kai-btn kai-btn-danger mr-auto md:hidden" onclick={removeCharacter} disabled={saving || deleting}>{deleting ? '삭제 중…' : '캐릭터 삭제'}</button>
                        <button class="kai-btn kai-btn-ghost" onclick={onclose} disabled={saving || deleting}>취소</button>
                        <button class="kai-btn kai-btn-primary" onclick={save} disabled={saving || deleting}>{saving ? '저장 중…' : '변경사항 저장'}</button>
                    </div>
                </div>
            </main>
        </div>
    {/if}
</div>
