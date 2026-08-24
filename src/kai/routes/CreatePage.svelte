<script lang="ts">
    import {
        ArrowLeft,
        ArrowRight,
        FolderArchive,
        ImageUp,
        Plus,
        Save,
        Trash2,
    } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'
    import { router } from '../lib/router.svelte'
    import { toasts } from '../stores/app.svelte'

    type LoreEntry = {
        id: string
        key: string
        secondkey: string
        content: string
        comment: string
        insertorder: number
        alwaysActive: boolean
        selective: boolean
        useRegex: boolean
    }

    type DraftSlot = {
        name: string
        tagline: string
        description: string
        scenario: string
        personality: string
        creatorNotes: string
        tags: string
        systemPrompt: string
        postHistoryInstructions: string
        exampleMessage: string
        depthPrompt: string
        depthValue: number
        firstMessage: string
        alternateGreetings: string[]
        globalLore: LoreEntry[]
        updatedAt: number
    }

    const DRAFT_STORAGE_KEY = 'kai_character_drafts_v2'
    const TOTAL_SLOTS = 5

    let editId = $state<string | null>(router.current.query.get('edit'))
    let loadingEdit = $state(false)

    // Form fields
    let name = $state('')
    let tagline = $state('')
    let description = $state('')
    let scenario = $state('')
    let personality = $state('')
    let creatorNotes = $state('')
    let tagsText = $state('')

    let avatarFile = $state<File | null>(null)
    let avatarPreviewUrl = $state<string | null>(null)

    let systemPrompt = $state('')
    let postHistoryInstructions = $state('')
    let exampleMessage = $state('')
    let depthPrompt = $state('')
    let depthValue = $state(4)

    let firstMessage = $state('')
    let alternateGreetings = $state<string[]>([])

    let globalLore = $state<LoreEntry[]>([])

    let saving = $state(false)
    let activeTab = $state<'basic' | 'prompts' | 'greetings' | 'lore' | 'drafts'>('basic')

    // Draft state
    let drafts = $state<Record<number, DraftSlot>>({})
    let activeSlot = $state<number>(1)

    const ready = $derived(
        Boolean(name.trim() && description.trim() && systemPrompt.trim() && firstMessage.trim()),
    )

    onMount(async () => {
        loadDraftsFromStorage()
        if (editId) {
            await loadExistingCharacter(editId)
        }
    })

    function loadDraftsFromStorage() {
        try {
            const raw = localStorage.getItem(DRAFT_STORAGE_KEY)
            if (raw) drafts = JSON.parse(raw)
        } catch {
            drafts = {}
        }
    }

    function saveDraftsToStorage() {
        try {
            localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
        } catch {
            // ignore quota errors
        }
    }

    async function loadExistingCharacter(id: string) {
        loadingEdit = true
        try {
            const detail = await api.characters.detail(id)
            name = detail.name || ''
            tagline = detail.tagline || ''
            description = typeof detail.description === 'string' ? detail.description : (detail.description as any)?.en || ''
            avatarPreviewUrl = detail.avatarUrl || null
            tagsText = (detail.tags || []).join(', ')

            const card = detail.card || {}
            scenario = String(card.scenario || '')
            personality = String(card.personality || '')
            creatorNotes = String(card.creatorNotes || '')
            systemPrompt = String(card.systemPrompt || '')
            postHistoryInstructions = String(card.postHistoryInstructions || card.replaceGlobalNote || '')
            exampleMessage = String(card.exampleMessage || '')
            if (card.depth_prompt && typeof card.depth_prompt === 'object') {
                depthValue = Number((card.depth_prompt as any).depth ?? 4)
                depthPrompt = String((card.depth_prompt as any).prompt ?? '')
            }

            firstMessage = String(card.firstMessage || '')
            alternateGreetings = Array.isArray(card.alternateGreetings) ? card.alternateGreetings.map(String) : []
            if (Array.isArray(card.globalLore)) {
                globalLore = card.globalLore.map((e: any, idx: number) => ({
                    id: e.id || `lore-${idx}-${Date.now()}`,
                    key: String(e.key || ''),
                    secondkey: String(e.secondkey || ''),
                    content: String(e.content || ''),
                    comment: String(e.comment || ''),
                    insertorder: Number(e.insertorder ?? 100),
                    alwaysActive: !!e.alwaysActive,
                    selective: !!e.selective,
                    useRegex: !!e.useRegex,
                }))
            }
            toasts.success('작품 정보를 불러왔습니다.')
        } catch (error) {
            toasts.error(error)
        } finally {
            loadingEdit = false
        }
    }

    function getCurrentFormSnapshot(): DraftSlot {
        return {
            name,
            tagline,
            description,
            scenario,
            personality,
            creatorNotes,
            tags: tagsText,
            systemPrompt,
            postHistoryInstructions,
            exampleMessage,
            depthPrompt,
            depthValue,
            firstMessage,
            alternateGreetings: [...alternateGreetings],
            globalLore: globalLore.map((item) => ({ ...item })),
            updatedAt: Date.now(),
        }
    }

    function saveToSlot(slotIndex: number) {
        drafts[slotIndex] = getCurrentFormSnapshot()
        saveDraftsToStorage()
        toasts.success(`임시저장 슬롯 ${slotIndex}번에 저장했습니다.`)
    }

    function loadFromSlot(slotIndex: number) {
        const slot = drafts[slotIndex]
        if (!slot) return
        name = slot.name || ''
        tagline = slot.tagline || ''
        description = slot.description || ''
        scenario = slot.scenario || ''
        personality = slot.personality || ''
        creatorNotes = slot.creatorNotes || ''
        tagsText = slot.tags || ''
        systemPrompt = slot.systemPrompt || ''
        postHistoryInstructions = slot.postHistoryInstructions || ''
        exampleMessage = slot.exampleMessage || ''
        depthPrompt = slot.depthPrompt || ''
        depthValue = slot.depthValue ?? 4
        firstMessage = slot.firstMessage || ''
        alternateGreetings = Array.isArray(slot.alternateGreetings) ? [...slot.alternateGreetings] : []
        globalLore = Array.isArray(slot.globalLore) ? slot.globalLore.map((item) => ({ ...item })) : []
        toasts.success(`임시저장 슬롯 ${slotIndex}번을 불러왔습니다.`)
    }

    function clearSlot(slotIndex: number) {
        if (!confirm(`슬롯 ${slotIndex}번의 임시저장을 삭제할까요?`)) return
        delete drafts[slotIndex]
        saveDraftsToStorage()
        toasts.success(`슬롯 ${slotIndex}번을 비웠습니다.`)
    }

    function handleAvatarChange(event: Event) {
        const input = event.currentTarget as HTMLInputElement
        const file = input.files?.[0]
        if (!file) return
        avatarFile = file
        avatarPreviewUrl = URL.createObjectURL(file)
    }

    function addAlternateGreeting() {
        alternateGreetings = [...alternateGreetings, '']
    }

    function removeAlternateGreeting(index: number) {
        alternateGreetings = alternateGreetings.filter((_, i) => i !== index)
    }

    function addLoreEntry() {
        globalLore = [
            ...globalLore,
            {
                id: `lore-${Date.now()}`,
                key: '',
                secondkey: '',
                content: '',
                comment: '',
                insertorder: 100,
                alwaysActive: false,
                selective: false,
                useRegex: false,
            },
        ]
    }

    function removeLoreEntry(index: number) {
        globalLore = globalLore.filter((_, i) => i !== index)
    }

    function preventMobileDrag(event: DragEvent) {
        if (window.innerWidth >= 768) return
        const target = event.target
        if (target instanceof Element && target.closest('a, img')) event.preventDefault()
    }

    async function handleSubmit(event: SubmitEvent) {
        event.preventDefault()
        if (!ready || saving) return
        saving = true

        const tags = tagsText
            .split(',')
            .map((t) => t.trim().replace(/^#/, ''))
            .filter(Boolean)

        const cardData: Record<string, unknown> = {
            type: 'character',
            name: name.trim(),
            desc: description.trim(),
            scenario: scenario.trim(),
            personality: personality.trim() || systemPrompt.trim(),
            creatorNotes: creatorNotes.trim(),
            systemPrompt: systemPrompt.trim(),
            postHistoryInstructions: postHistoryInstructions.trim(),
            exampleMessage: exampleMessage.trim(),
            depth_prompt: { depth: depthValue, prompt: depthPrompt.trim() },
            firstMessage: firstMessage.trim(),
            alternateGreetings: alternateGreetings.map((g) => g.trim()).filter(Boolean),
            globalLore: globalLore.map((l) => ({
                id: l.id,
                key: l.key.trim(),
                secondkey: l.secondkey.trim(),
                content: l.content.trim(),
                comment: l.comment.trim(),
                insertorder: Number(l.insertorder || 100),
                alwaysActive: !!l.alwaysActive,
                selective: !!l.selective,
                useRegex: !!l.useRegex,
            })),
            tags,
        }

        try {
            if (editId) {
                const updated = await api.characters.update(editId, {
                    name: name.trim(),
                    tagline: tagline.trim() || description.trim().slice(0, 120),
                    creatorNotes: creatorNotes.trim(),
                    tags,
                    card: cardData,
                })
                if (avatarFile) {
                    await api.characters.setAvatar(editId, avatarFile)
                }
                toasts.success('작품을 수정했습니다.')
                router.go(`/c/${updated.slug}`)
            } else {
                const character = await api.characters.create({
                    name: name.trim(),
                    description: description.trim(),
                    scenario: scenario.trim(),
                    systemPrompt: systemPrompt.trim(),
                    firstMessage: firstMessage.trim(),
                })
                // Save complete card settings
                await api.characters.update(character.id, {
                    name: name.trim(),
                    tagline: tagline.trim() || description.trim().slice(0, 120),
                    creatorNotes: creatorNotes.trim(),
                    tags,
                    card: cardData,
                })
                if (avatarFile) {
                    await api.characters.setAvatar(character.id, avatarFile)
                }
                toasts.success('작품을 만들었습니다. 장르 태그도 자동으로 분류했습니다.')
                router.go(`/c/${character.slug}`)
            }
        } catch (error) {
            toasts.error(error)
        } finally {
            saving = false
        }
    }
</script>

<svelte:window ondragstart={preventMobileDrag} />

<div class="kai-page-container kai-create-page kai-mobile-drag-guard">
    <header class="kai-page-heading">
        <div class="flex items-center justify-between gap-4">
            <div>
                <h1 class="kai-page-title">{editId ? '작품 수정' : '작품 제작'}</h1>
                <p>{editId ? '캐릭터의 전체 프롬프트와 세부 설정을 수정합니다.' : '캐릭터의 프롬프트, 로어북, 시작 장면을 직접 작성합니다.'}</p>
            </div>
            {#if editId}
                <button class="kai-btn kai-btn-ghost" onclick={() => router.back()}><ArrowLeft size={16} /> 돌아가기</button>
            {/if}
        </div>
    </header>

    <!-- Navigation Tabs for Editor Sections -->
    <nav class="mt-5 flex flex-wrap gap-2 border-b border-kai-border-soft pb-3" aria-label="에디터 섹션">
        <button
            type="button"
            class="kai-btn {activeTab === 'basic' ? 'kai-btn-primary' : 'kai-btn-ghost'} text-xs"
            onclick={() => activeTab = 'basic'}
        >01 기본 정보 & 이미지</button>
        <button
            type="button"
            class="kai-btn {activeTab === 'prompts' ? 'kai-btn-primary' : 'kai-btn-ghost'} text-xs"
            onclick={() => activeTab = 'prompts'}
        >02 프롬프트 & 지시문</button>
        <button
            type="button"
            class="kai-btn {activeTab === 'greetings' ? 'kai-btn-primary' : 'kai-btn-ghost'} text-xs"
            onclick={() => activeTab = 'greetings'}
        >03 첫 메시지 ({1 + alternateGreetings.length})</button>
        <button
            type="button"
            class="kai-btn {activeTab === 'lore' ? 'kai-btn-primary' : 'kai-btn-ghost'} text-xs"
            onclick={() => activeTab = 'lore'}
        >04 로어북 ({globalLore.length})</button>
        <button
            type="button"
            class="kai-btn {activeTab === 'drafts' ? 'kai-btn-primary' : 'kai-btn-ghost'} text-xs"
            onclick={() => activeTab = 'drafts'}
        ><FolderArchive size={14} /> 임시저장 슬롯</button>
    </nav>

    {#if loadingEdit}
        <p class="py-24 text-center text-kai-faint">작품 정보를 불러오는 중…</p>
    {:else}
        <form class="kai-creator-editor mt-6" onsubmit={handleSubmit}>

            <!-- 01 기본 정보 & 이미지 -->
            {#if activeTab === 'basic'}
                <section class="kai-card kai-creator-section">
                    <div class="kai-creator-section-heading">
                        <span>01</span>
                        <div><h2>작품 기본 정보</h2><p>목록과 상세 화면에 표시될 대표 정보입니다.</p></div>
                    </div>
                    <div class="kai-creator-fields">
                        <label>
                            <span>작품 이름 <b>필수</b></span>
                            <input class="kai-input" bind:value={name} maxlength="120" placeholder="예: 달빛 아래의 기록관" required />
                        </label>
                        <label>
                            <span>한줄 요약 (태그라인) <i>선택</i></span>
                            <input class="kai-input" bind:value={tagline} maxlength="160" placeholder="카드의 매력을 한 문장으로 요약해 주세요." />
                        </label>
                        <label>
                            <span>소개글 <b>필수</b></span>
                            <textarea class="kai-input min-h-28 resize-y" bind:value={description} maxlength="12000" placeholder="캐릭터와 작품의 매력을 소개하세요." required></textarea>
                        </label>
                        <label>
                            <span>상황 설정 (Scenario) <i>선택</i></span>
                            <textarea class="kai-input min-h-24 resize-y" bind:value={scenario} maxlength="12000" placeholder="사용자와 캐릭터가 만나는 배경, 장소, 시간, 관계 등을 작성합니다."></textarea>
                        </label>
                        <label>
                            <span>성격 및 성향 (Personality) <i>선택</i></span>
                            <textarea class="kai-input min-h-24 resize-y" bind:value={personality} maxlength="12000" placeholder="캐릭터의 성격, 말투, 신체적 특징 등을 작성합니다."></textarea>
                        </label>
                        <label>
                            <span>제작자 코멘트 <i>선택</i></span>
                            <textarea class="kai-input min-h-20 resize-y" bind:value={creatorNotes} maxlength="5000" placeholder="대화방 상단에 표시되는 제작자의 팁이나 세계관 안내입니다."></textarea>
                        </label>
                        <label>
                            <span>장르 & 태그 <i>(쉼표로 구분)</i></span>
                            <input class="kai-input" bind:value={tagsText} placeholder="예: 판타지/SF, 마법사, 츤데레" />
                        </label>
                    </div>

                    <div class="mt-6 border-t border-kai-border-soft pt-5">
                        <span class="text-sm font-bold text-kai-text">대표 이미지 (아바타)</span>
                        <div class="mt-3 flex items-center gap-4">
                            <div class="grid h-24 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-kai-border bg-kai-surface-2">
                                {#if avatarPreviewUrl}
                                    <img src={avatarPreviewUrl} alt="미리보기" class="h-full w-full object-cover" draggable="false" />
                                {:else}
                                    <ImageUp size={24} class="text-kai-faint" />
                                {/if}
                            </div>
                            <div>
                                <label class="kai-btn kai-btn-ghost cursor-pointer text-xs">
                                    <ImageUp size={15} /> 이미지 선택
                                    <input
                                        type="file"
                                        accept="image/png,image/jpeg,image/gif,image/webp"
                                        class="sr-only"
                                        onchange={handleAvatarChange}
                                    />
                                </label>
                                <p class="mt-1 text-[11px] text-kai-faint">PNG, JPG, GIF, WebP (최대 50MB)</p>
                            </div>
                        </div>
                    </div>
                </section>
            {/if}

            <!-- 02 프롬프트 & 지시문 -->
            {#if activeTab === 'prompts'}
                <section class="kai-card kai-creator-section">
                    <div class="kai-creator-section-heading">
                        <span>02</span>
                        <div><h2>캐릭터 프롬프트 & 시스템 지시문</h2><p>AI의 말투, 롤플레잉 규칙, 고정 지시문을 작성합니다.</p></div>
                    </div>
                    <div class="kai-creator-fields">
                        <label>
                            <span>메인 시스템 프롬프트 (System Prompt) <b>필수</b></span>
                            <textarea
                                class="kai-input kai-prompt-textarea min-h-48 font-mono text-xs"
                                bind:value={systemPrompt}
                                maxlength="20000"
                                placeholder="당신은 … 역할을 맡는다. 성격은 …이며, 대화할 때 …"
                                required
                            ></textarea>
                            <small class="text-right text-kai-faint">{systemPrompt.length.toLocaleString()} / 20,000</small>
                        </label>

                        <label>
                            <span>사후 지시문 (Post-History Instructions) <i>선택</i></span>
                            <textarea
                                class="kai-input min-h-28 font-mono text-xs"
                                bind:value={postHistoryInstructions}
                                maxlength="10000"
                                placeholder="대화 기록 뒤에 붙는 지시문입니다 (예: [System Note: 대화의 분위기를 어둡게 유지하세요])."
                            ></textarea>
                        </label>

                        <label>
                            <span>예시 대화 (Dialogue Examples) <i>선택</i></span>
                            <textarea
                                class="kai-input min-h-28 font-mono text-xs"
                                bind:value={exampleMessage}
                                maxlength="15000"
                                placeholder="&lt;START&gt;&#10;&#123;&#123;user&#125;&#125;: 안녕하세요?&#10;&#123;&#123;char&#125;&#125;: 반가워요!"
                            ></textarea>
                        </label>

                        <div class="grid gap-3 sm:grid-cols-4">
                            <label class="sm:col-span-1">
                                <span>심도 (Depth)</span>
                                <input type="number" class="kai-input" bind:value={depthValue} min="0" max="20" />
                            </label>
                            <label class="sm:col-span-3">
                                <span>심도 프롬프트 (Depth Prompt) <i>선택</i></span>
                                <input class="kai-input" bind:value={depthPrompt} placeholder="특정 깊이에 주입할 지시문" />
                            </label>
                        </div>
                    </div>
                </section>
            {/if}

            <!-- 03 첫 메시지 & 다양한 시작 장면 -->
            {#if activeTab === 'greetings'}
                <section class="kai-card kai-creator-section">
                    <div class="kai-creator-section-heading">
                        <span>03</span>
                        <div><h2>첫 메시지 & 대체 첫 장면</h2><p>대화를 시작할 때 처음 마주할 장면과 선택 가능한 추가 오프닝입니다.</p></div>
                    </div>

                    <div class="kai-creator-fields">
                        <label>
                            <span>기본 첫 메시지 <b>필수</b></span>
                            <textarea
                                class="kai-input kai-first-message-textarea min-h-36 resize-y"
                                bind:value={firstMessage}
                                maxlength="20000"
                                placeholder="*문이 천천히 열리고, 캐릭터가 사용자를 바라본다.*&#10;&#10;“드디어 왔군요.”"
                                required
                            ></textarea>
                            <small class="text-right text-kai-faint">{firstMessage.length.toLocaleString()} / 20,000</small>
                        </label>

                        <div class="mt-4 space-y-4">
                            <div class="flex items-center justify-between">
                                <span class="text-sm font-bold text-kai-text">추가 대체 첫 장면 ({alternateGreetings.length}개)</span>
                                <button type="button" class="kai-btn kai-btn-ghost text-xs" onclick={addAlternateGreeting}>
                                    <Plus size={14} /> 대체 첫 장면 추가
                                </button>
                            </div>

                            {#each alternateGreetings as greeting, gIdx}
                                <div class="rounded-xl border border-kai-border-soft bg-kai-surface-2 p-3">
                                    <div class="mb-2 flex items-center justify-between">
                                        <span class="text-xs font-semibold text-kai-dim">대체 오프닝 #{gIdx + 1}</span>
                                        <button
                                            type="button"
                                            class="kai-icon-action text-kai-faint hover:text-red-400"
                                            aria-label="삭제"
                                            onclick={() => removeAlternateGreeting(gIdx)}
                                        ><Trash2 size={15} /></button>
                                    </div>
                                    <textarea
                                        class="kai-input min-h-24 resize-y text-xs"
                                        bind:value={alternateGreetings[gIdx]}
                                        placeholder="다른 상황이나 분기에서 시작하는 첫 메시지를 적어주세요."
                                    ></textarea>
                                </div>
                            {/each}
                        </div>
                    </div>
                </section>
            {/if}

            <!-- 04 로어북 -->
            {#if activeTab === 'lore'}
                <section class="kai-card kai-creator-section">
                    <div class="kai-creator-section-heading">
                        <span>04</span>
                        <div><h2>로어북 (세계관 / World Info)</h2><p>특정 키워드가 대화에 등장할 때 자동으로 주입되는 설정 사전입니다.</p></div>
                    </div>

                    <div class="kai-creator-fields">
                        <div class="flex items-center justify-between">
                            <span class="text-sm font-bold text-kai-text">로어북 항목 ({globalLore.length}개)</span>
                            <button type="button" class="kai-btn kai-btn-ghost text-xs" onclick={addLoreEntry}>
                                <Plus size={14} /> 새 항목 추가
                            </button>
                        </div>

                        {#if !globalLore.length}
                            <p class="py-8 text-center text-xs text-kai-faint">등록된 로어북 항목이 없습니다. '+ 새 항목 추가'를 눌러 항목을 추가해 보세요.</p>
                        {:else}
                            <div class="space-y-4">
                                {#each globalLore as entry, lIdx}
                                    <div class="rounded-xl border border-kai-border-soft bg-kai-surface-2 p-4">
                                        <div class="mb-3 flex items-center justify-between gap-2">
                                            <span class="text-xs font-bold text-kai-accent">항목 #{lIdx + 1} {entry.comment ? `(${entry.comment})` : ''}</span>
                                            <button
                                                type="button"
                                                class="kai-icon-action text-kai-faint hover:text-red-400"
                                                aria-label="삭제"
                                                onclick={() => removeLoreEntry(lIdx)}
                                            ><Trash2 size={15} /></button>
                                        </div>

                                        <div class="grid gap-3 sm:grid-cols-2">
                                            <label>
                                                <span class="text-xs">주석 / 설명</span>
                                                <input class="kai-input text-xs" bind:value={entry.comment} placeholder="예: 왕국 역사, 주요 인물" />
                                            </label>
                                            <label>
                                                <span class="text-xs">활성화 키워드 (쉼표 구분)</span>
                                                <input class="kai-input text-xs" bind:value={entry.key} placeholder="예: 아르카디아, 수도, 황제" />
                                            </label>
                                            <label class="sm:col-span-2">
                                                <span class="text-xs">내용 (Content)</span>
                                                <textarea class="kai-input min-h-24 resize-y text-xs" bind:value={entry.content} placeholder="키워드 감지 시 주입될 설정 내용"></textarea>
                                            </label>
                                            <div class="flex flex-wrap items-center gap-4 sm:col-span-2 text-xs">
                                                <label class="inline-flex items-center gap-2 cursor-pointer">
                                                    <input type="checkbox" bind:checked={entry.alwaysActive} />
                                                    <span>상시 활성화 (Constant)</span>
                                                </label>
                                                <label class="inline-flex items-center gap-2 cursor-pointer">
                                                    <input type="checkbox" bind:checked={entry.selective} />
                                                    <span>선택적 (Selective)</span>
                                                </label>
                                                <label class="inline-flex items-center gap-2 cursor-pointer">
                                                    <input type="checkbox" bind:checked={entry.useRegex} />
                                                    <span>정규식 사용</span>
                                                </label>
                                                <label class="inline-flex items-center gap-2">
                                                    <span>삽입 순서:</span>
                                                    <input type="number" class="kai-input w-20 text-xs py-1" bind:value={entry.insertorder} />
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                </section>
            {/if}

            <!-- 05 임시저장 슬롯 관리 -->
            {#if activeTab === 'drafts'}
                <section class="kai-card kai-creator-section">
                    <div class="kai-creator-section-heading">
                        <span>05</span>
                        <div><h2>임시저장 슬롯 관리</h2><p>작성 중인 설정을 슬롯별로 저장하거나 언제든지 불러올 수 있습니다.</p></div>
                    </div>

                    <div class="grid gap-3 sm:grid-cols-1 md:grid-cols-2">
                        {#each Array.from({ length: TOTAL_SLOTS }, (_, i) => i + 1) as slotIndex}
                            {@const slot = drafts[slotIndex]}
                            <div class="rounded-xl border {slot ? 'border-kai-accent/40 bg-kai-surface-2' : 'border-kai-border-soft bg-kai-surface'} p-4">
                                <div class="flex items-start justify-between gap-2">
                                    <div>
                                        <div class="flex items-center gap-2">
                                            <span class="rounded-md bg-kai-accent/15 px-2 py-0.5 text-xs font-bold text-kai-accent">슬롯 {slotIndex}</span>
                                            <h3 class="font-bold text-sm">{slot?.name || '비어 있음'}</h3>
                                        </div>
                                        {#if slot}
                                            <p class="mt-1 line-clamp-1 text-xs text-kai-dim">{slot.description || slot.tagline || '소개 없음'}</p>
                                            <p class="mt-1 text-[10px] text-kai-faint">저장일: {new Date(slot.updatedAt).toLocaleString('ko-KR')}</p>
                                        {:else}
                                            <p class="mt-1 text-xs text-kai-faint">저장된 내용이 없습니다.</p>
                                        {/if}
                                    </div>
                                    {#if slot}
                                        <button
                                            type="button"
                                            class="kai-icon-action text-kai-faint hover:text-red-400"
                                            title="슬롯 비우기"
                                            onclick={() => clearSlot(slotIndex)}
                                        ><Trash2 size={15} /></button>
                                    {/if}
                                </div>
                                <div class="mt-4 flex gap-2">
                                    <button
                                        type="button"
                                        class="kai-btn kai-btn-primary flex-1 text-xs py-2"
                                        onclick={() => saveToSlot(slotIndex)}
                                    >현재 내용 저장</button>
                                    {#if slot}
                                        <button
                                            type="button"
                                            class="kai-btn kai-btn-ghost flex-1 text-xs py-2"
                                            onclick={() => loadFromSlot(slotIndex)}
                                        >불러오기</button>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                </section>
            {/if}

            <div class="kai-creator-submit mt-8">
                <p>{editId ? '수정된 설정은 즉시 적용됩니다.' : '저장하면 장르가 자동 분류되며, 작품이 공개 상태로 생성됩니다.'}</p>
                <div class="flex items-center gap-3">
                    <button
                        type="button"
                        class="kai-btn kai-btn-ghost"
                        onclick={() => saveToSlot(activeSlot)}
                    ><Save size={16} /> 슬롯 {activeSlot} 임시저장</button>
                    <button class="kai-btn kai-btn-primary" disabled={!ready || saving}>
                        {#if saving}<Save size={17} /> 저장 중…{:else}{editId ? '변경사항 저장' : '작품 만들기'} <ArrowRight size={17} />{/if}
                    </button>
                </div>
            </div>
        </form>
    {/if}
</div>
