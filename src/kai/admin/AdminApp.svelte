<script lang="ts">
    import { Compass, Search, X } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api, apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload } from '../api/client'
    import { router } from '../lib/router.svelte'
    import { appConfig, toasts } from '../stores/app.svelte'
    import CharacterEditor from './CharacterEditor.svelte'
    import RealmBulkImport from './RealmBulkImport.svelte'
    import StatusPage from '../routes/StatusPage.svelte'
    import UserEditor from './UserEditor.svelte'
    let { section }: { section:string }=$props()
    let tab=$derived(section==='route'?'routing':(section||'overview'))

    /**
     * `data` is whatever `dataTab` was loaded for — never assumed to match the
     * tab in the URL. Effects run a tick after the derived `tab` changes, so
     * rendering straight off `tab` would briefly feed one tab's markup the
     * previous tab's data and throw, which left the page stuck on screen while
     * the address bar had already moved on.
     */
    let data=$state<any>(null),dataTab=$state(''),loading=$state(true)
    let file=$state<File|null>(null),pluginSource=$state(''),uploadingCharacter=$state(false)
    let editingCharacterId=$state<string|null>(null)
    let editingUser=$state<any>(null)
    let presetFile=$state<File|null>(null),moduleFile=$state<File|null>(null),hypaFile=$state<File|null>(null)
    let realmModalOpen=$state(false)
    let characterSearch=$state('')
    let filteredCharacters=$derived(
        dataTab === 'characters' && Array.isArray(data)
            ? data.filter((c: any) =>
                !characterSearch.trim() ||
                c.name.toLowerCase().includes(characterSearch.trim().toLowerCase()) ||
                (c.creatorName && c.creatorName.toLowerCase().includes(characterSearch.trim().toLowerCase())) ||
                (c.tagline && c.tagline.toLowerCase().includes(characterSearch.trim().toLowerCase()))
              )
            : []
    )
    const tabs=[['overview','개요'],['status','서버 상태'],['characters','캐릭터'],['routing','모델 라우팅'],['settings','서비스 설정'],['engine','프리셋·모듈'],['plugins','플러그인'],['users','사용자'],['logs','접속/작업 로그']]
    let stale=$derived(loading||dataTab!==tab)
    $effect(()=>{tab;void load()})

    async function fetchFor(t:string){
        if(t==='overview')return await apiGet('/admin/stats')
        if(t==='characters')return await apiGet('/admin/characters')
        if(t==='routing'||t==='route')return await apiGet('/admin/omniroute/dashboard')
        if(t==='settings')return await apiGet('/admin/settings')
        if(t==='engine'){const [presets,modules,hypa,toggles]=await Promise.all([apiGet('/admin/presets'),apiGet('/admin/modules'),apiGet('/admin/hypa'),apiGet('/admin/toggles')]);return {presets,modules,hypa,toggles}}
        if(t==='plugins')return await apiGet('/admin/plugins')
        if(t==='users')return await apiGet('/admin/users')
        if(t==='logs')return await Promise.all([apiGet('/admin/audit'),apiGet('/admin/users')])
        return null
    }

    // Navigating away mid-fetch must not let the older response land: it would
    // paint the wrong tab's data and clear the spinner early.
    let seq=0
    async function load(){
        const forTab=tab,mine=++seq
        loading=true
        try{const next=await fetchFor(forTab);if(mine!==seq)return;data=next;dataTab=forTab}
        catch(e){if(mine===seq)toasts.error(e)}
        finally{if(mine===seq)loading=false}
    }

    async function patch(path:string,b:any){try{await apiPatch(path,b);toasts.success('저장했습니다.');await load();await appConfig.load()}catch(e){toasts.error(e)}}
    /**
     * Settings go over PUT, and the server merges the body onto the *defaults*
     * rather than onto the stored value — so a partial body silently resets
     * every field it omits. Always send the whole section back.
     */
    async function saveSettings(key:string,next:any){try{await apiPut(`/admin/settings/${key}`,{...data[key],...next});toasts.success('저장했습니다.');await load();await appConfig.load()}catch(e){toasts.error(e)}}
    async function upload(){if(!file||uploadingCharacter)return;uploadingCharacter=true;try{const r=await api.characters.importFile(file);toasts.success(`${r.character.name} 가져오기 완료${r.assetCount?` (에셋 ${r.assetCount}개)`:''}`);file=null;await load()}catch(e){toasts.error(e)}finally{uploadingCharacter=false}}
    async function deleteCharacter(character:any){if(!confirm(`“${character.name}” 캐릭터를 삭제할까요? 연결된 모든 대화와 메시지도 함께 삭제되며 되돌릴 수 없습니다.`))return;try{await apiDelete(`/admin/characters/${character.id}`);toasts.success('캐릭터를 삭제했습니다.');await load();await appConfig.load()}catch(e){toasts.error(e)}}
    async function install(){try{await apiPost('/admin/plugins',{source:pluginSource,enabled:true,forced:true});pluginSource='';toasts.success('플러그인을 설치했습니다.');await load()}catch(e){toasts.error(e)}}
    // Engine imports all reload the runtime config: a preset or module change
    // must reach every open client, not just this admin session.
    async function importEngineFile(path:string,f:File|null,done:(r:any)=>string){if(!f)return;try{const r=await apiUpload<any>(path,f);toasts.success(done(r));presetFile=null;moduleFile=null;hypaFile=null;await load();await appConfig.load()}catch(e){toasts.error(e)}}
    async function removeEngine(path:string){try{await apiDelete(path);toasts.success('삭제했습니다.');await load();await appConfig.load()}catch(e){toasts.error(e)}}

    /**
     * Working copy of the toggle picks. Reset from the server on every load so
     * importing a different preset replaces the options rather than merging
     * with what the previous preset happened to declare.
     */
    let toggleDraft=$state<Record<string,string>>({})
    $effect(()=>{if(dataTab==='engine'&&data?.toggles)toggleDraft={...data.toggles.values}})
    async function saveToggles(){try{await apiPut('/admin/toggles',toggleDraft);toasts.success('저장했습니다.');await load();await appConfig.load()}catch(e){toasts.error(e)}}

    async function updateOmniProvider(id: string, updates: { priority?: number; isActive?: boolean }) {
        try {
            await apiPatch(`/admin/omniroute/providers/${id}`, updates)
            toasts.success('OmniRoute 제공자 설정을 저장했습니다.')
            await load()
        } catch (e) {
            toasts.error(e)
        }
    }

    async function moveProviderPriority(provider: any, direction: 'up' | 'down') {
        const sorted = [...(data?.providers || [])].sort((a: any, b: any) => a.priority - b.priority)
        const idx = sorted.findIndex((p: any) => p.id === provider.id)
        if (idx === -1) return
        const targetIdx = direction === 'up' ? idx - 1 : idx + 1
        if (targetIdx < 0 || targetIdx >= sorted.length) return

        const current = sorted[idx]
        const other = sorted[targetIdx]

        const order = sorted.map((p: any, i: number) => {
            if (i === idx) return { id: p.id, priority: other.priority }
            if (i === targetIdx) return { id: p.id, priority: current.priority }
            return { id: p.id, priority: p.priority }
        })

        try {
            await apiPost('/admin/omniroute/providers/reorder', { order })
            toasts.success('우선순위를 변경했습니다.')
            await load()
        } catch (e) {
            toasts.error(e)
        }
    }

    /** Empty input means "don't send this sampler at all", not zero. */
    const num=(v:FormDataEntryValue|null)=>{const t=String(v??'').trim();return t===''?null:Number(t)}
    /** Comma-separated list field. An empty box is an empty list, not a reset. */
    const csv=(v:FormDataEntryValue|null)=>String(v??'').split(',').map(s=>s.trim()).filter(Boolean)
</script>
<div class="flex h-full min-h-0 bg-kai-bg"><aside class="hidden w-64 shrink-0 border-r border-kai-border-soft bg-kai-surface p-4 md:flex md:flex-col"><a href="/" class="mb-7 flex items-center gap-3 px-2"><img src={appConfig.site?.logoUrl || '/kai-logo.png?v=2'} alt="" aria-hidden="true" class="h-9 w-9 rounded-xl object-cover"/><div><b>KAI Admin</b></div></a><nav class="space-y-1">{#each tabs as t}<a href={`/admin/${t[0]}`} class="block rounded-xl px-3 py-2.5 text-sm {tab===t[0]?'bg-kai-accent-soft text-kai-text':'text-kai-dim hover:bg-kai-surface-2'}">{t[1]}</a>{/each}</nav><a href="/" class="kai-btn kai-btn-ghost mt-auto">서비스로 돌아가기</a></aside>
<main class="kai-scroll min-w-0 flex-1 overflow-y-auto" data-kai-route-scroll><header class="sticky top-0 z-20 flex h-16 items-center border-b border-kai-border-soft bg-kai-bg/90 px-4 backdrop-blur md:px-8"><button class="mr-3 md:hidden" onclick={()=>router.go('/')}>←</button><h1 class="text-lg font-bold">{tabs.find(x=>x[0]===tab)?.[1]??'관리자'}</h1><select class="kai-input ml-auto w-36 md:hidden" value={tab} onchange={(e)=>router.go(`/admin/${e.currentTarget.value}`)}>{#each tabs as t}<option value={t[0]}>{t[1]}</option>{/each}</select></header>
<div class="mx-auto max-w-6xl p-4 md:p-8">{#if stale}<p class="py-20 text-center text-kai-faint">불러오는 중…</p>{:else if tab==='overview'}<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{#each [['사용자',data.users.total],['전체 대화',data.chats.total],['메시지',data.messages.total],['공개 캐릭터',data.characters.public]] as x}<div class="kai-card p-5"><p class="text-sm text-kai-dim">{x[0]}</p><p class="mt-2 text-3xl font-black">{Number(x[1]).toLocaleString()}</p></div>{/each}<div class="kai-card p-5 sm:col-span-2 lg:col-span-4"><h2 class="font-bold">오늘의 라우팅</h2><p class="mt-3 text-sm text-kai-dim">요청 {data.routing.requestsToday} · 성공률 {(data.routing.successRate*100).toFixed(1)}% · 중앙 지연 {data.routing.p50LatencyMs??'-'}ms</p></div></div>
{:else if tab==='status'}<StatusPage embedded />
{:else if tab==='characters'}
<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
    <button class="kai-btn kai-btn-ghost flex items-center gap-2 border border-kai-border-soft" onclick={()=>realmModalOpen=true}>
        <Compass size={17}/> RisuRealm 둘러보기 및 가져오기
    </button>
    <div class="relative w-full max-w-xs">
        <input class="kai-input w-full pl-9 pr-8 text-sm" placeholder="등록된 캐릭터 검색…" bind:value={characterSearch}/>
        <Search size={15} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kai-faint"/>
        {#if characterSearch}
            <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-kai-faint hover:text-kai-text" onclick={()=>characterSearch=''}><X size={14}/></button>
        {/if}
    </div>
</div>

{#if realmModalOpen}
    <div class="fixed inset-0 z-50 flex flex-col bg-black/60 backdrop-blur-sm p-4 md:p-8" role="dialog" aria-modal="true" aria-label="RisuRealm 둘러보기">
        <div class="mx-auto flex h-full w-full max-w-5xl flex-col rounded-2xl bg-kai-bg shadow-2xl overflow-hidden border border-kai-border-soft">
            <header class="flex h-14 shrink-0 items-center justify-between border-b border-kai-border-soft bg-kai-surface px-6">
                <h2 class="font-bold">RisuRealm 둘러보기 및 가져오기</h2>
                <button class="kai-btn kai-btn-ghost text-sm" onclick={()=>realmModalOpen=false}>닫기 (✕)</button>
            </header>
            <div class="flex-1 overflow-y-auto p-4 md:p-6 kai-scroll">
                <RealmBulkImport onimported={load}/>
            </div>
        </div>
    </div>
{/if}

<div class="kai-card mb-5 p-5"><h2 class="font-bold">RisuAI 카드 가져오기</h2><p class="mt-1 text-sm text-kai-dim">PNG, JSON, CHARX와 기존 RisuAI 확장 필드를 보존하며 공개 상태로 추가합니다.</p><div class="mt-4 flex flex-wrap items-center gap-2"><input type="file" accept=".png,.json,.charx" disabled={uploadingCharacter} onchange={(e)=>file=e.currentTarget.files?.[0]??null}/>{#if file}<span class="font-mono text-xs text-kai-dim">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>{/if}<button class="kai-btn kai-btn-primary" disabled={!file || uploadingCharacter} onclick={upload}>{#if uploadingCharacter}<span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent mr-1.5"></span>가져오는 중…{:else}가져오기{/if}</button></div>{#if file && file.size > 20 * 1024 * 1024}<p class="mt-2 text-xs text-kai-faint">대용량 파일({(file.size / 1024 / 1024).toFixed(1)} MB)은 업로드 및 처리에 수 초~수십 초 걸릴 수 있습니다.</p>{/if}</div>

<div class="space-y-2">
    {#each filteredCharacters as c}
        <div class="kai-card flex flex-wrap items-center gap-3 p-3">
            {#if c.avatarAssetId}<img src={`/api/assets/${c.avatarAssetId}`} alt="" class="h-14 w-12 rounded-lg object-cover"/>{/if}
            <div class="min-w-40 flex-1">
                <p class="truncate font-semibold">{c.name}</p>
                <p class="text-xs text-kai-faint">{c.visibility === 'public' ? '공개' : '비공개'} · 대화 {c.chatCount} · 로어/프롬프트 편집 가능</p>
            </div>
            <select class="kai-input w-32" value={c.visibility} onchange={(e)=>patch(`/admin/characters/${c.id}`,{visibility:e.currentTarget.value})}>
                <option value="public">공개</option>
                <option value="private">비공개</option>
            </select>
            <button class="kai-chip {c.featured?'kai-chip-active':''}" onclick={()=>patch(`/admin/characters/${c.id}`,{featured:!c.featured})}>추천</button>
            <button class="kai-btn kai-btn-ghost" onclick={()=>editingCharacterId=c.id}>편집</button>
            <button class="kai-btn kai-btn-danger" onclick={()=>deleteCharacter(c)}>삭제</button>
        </div>
    {/each}
    {#if !filteredCharacters.length}
        <p class="py-8 text-center text-sm text-kai-faint">{characterSearch ? '검색 결과가 없습니다.' : '등록된 캐릭터가 없습니다.'}</p>
    {/if}
</div>
{:else if tab==='routing'}
<div class="space-y-6">
    <div class="kai-card p-5">
        <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
                <h2 class="text-lg font-bold">OmniRoute 대시보드 및 모델 우선순위</h2>
                <p class="mt-1 text-sm text-kai-dim">
                    OmniRoute 실시간 라우팅 분석, 토큰 헬스 및 제공자 모델 우선순위(Priority)를 직접 제어합니다.
                </p>
            </div>
            <button class="kai-btn kai-btn-ghost" onclick={load}>
                새로고침
            </button>
        </div>

        <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-xl bg-kai-surface-2 p-4">
                <p class="text-xs text-kai-dim">전체 요청 수</p>
                <p class="mt-1 text-2xl font-black">{data.telemetry?.count ?? data.stats?.reduce((a, b) => a + (b.totalRequests || 0), 0) ?? 0}</p>
            </div>
            <div class="rounded-xl bg-kai-surface-2 p-4">
                <p class="text-xs text-kai-dim">중앙 지연시간 (P50)</p>
                <p class="mt-1 text-2xl font-black">{data.telemetry?.p50 ?? '-'} ms</p>
                <p class="text-[11px] text-kai-faint">P95: {data.telemetry?.p95 ?? '-'} ms</p>
            </div>
            <div class="rounded-xl bg-kai-surface-2 p-4">
                <p class="text-xs text-kai-dim">토큰 헬스 상태</p>
                <p class="mt-1 text-2xl font-black capitalize text-kai-ok">{data.tokenHealth?.status ?? 'healthy'}</p>
                <p class="text-[11px] text-kai-faint">정상 토큰 {data.tokenHealth?.healthy ?? 0} / 전체 {data.tokenHealth?.total ?? 0}</p>
            </div>
            <div class="rounded-xl bg-kai-surface-2 p-4">
                <p class="text-xs text-kai-dim">등록된 모델 수</p>
                <p class="mt-1 text-2xl font-black">{data.models?.length ?? 0}</p>
                <p class="text-[11px] text-kai-faint">OmniRoute 자동 라우팅 준비 완료</p>
            </div>
        </div>
    </div>

    <div class="kai-card p-5">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
                <h3 class="font-bold text-base">제공자 모델 우선순위 설정</h3>
                <p class="text-xs text-kai-dim">숫자가 낮을수록(1, 2, 3...) 우선 사용되며, 장애 시 다음 순위로 자동 페일오버됩니다.</p>
            </div>
        </div>

        <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
                <thead class="text-kai-faint border-b border-kai-border-soft">
                    <tr>
                        <th class="p-3 w-16 text-center">우선순위</th>
                        <th class="p-3">제공자 / 연결 이름</th>
                        <th class="p-3">상태</th>
                        <th class="p-3">요청 / 성공</th>
                        <th class="p-3">평균 지연</th>
                        <th class="p-3 text-right">설정 및 순서</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-kai-border-soft">
                    {#each (data.providers || []) as p, idx}
                        {@const pStat = (data.stats || []).find(s => String(s.provider || '').toLowerCase() === String(p.provider || '').toLowerCase())}
                        <tr class="hover:bg-kai-surface-2/50 transition-colors">
                            <td class="p-3 text-center">
                                <span class="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-kai-accent-soft font-bold text-kai-text text-xs">
                                    {p.priority}
                                </span>
                            </td>
                            <td class="p-3">
                                <div class="flex items-center gap-2">
                                    <span class="h-2.5 w-2.5 rounded-full {p.isActive ? 'bg-kai-ok' : 'bg-kai-faint'}"></span>
                                    <div>
                                        <b class="capitalize text-kai-text">{p.name || p.provider}</b>
                                        <p class="text-xs text-kai-faint font-mono">{p.provider} ({p.id.slice(0, 8)})</p>
                                    </div>
                                </div>
                            </td>
                            <td class="p-3">
                                <span class="kai-chip text-xs capitalize {p.testStatus === 'active' ? 'text-kai-ok' : 'text-kai-warn'}">
                                    {p.testStatus || 'active'}
                                </span>
                            </td>
                            <td class="p-3">
                                <p class="text-xs">{pStat ? `${pStat.successfulRequests} / ${pStat.totalRequests}` : '-'}</p>
                            </td>
                            <td class="p-3">
                                <p class="text-xs">{pStat?.avgLatencyMs ? `${pStat.avgLatencyMs} ms` : '-'}</p>
                            </td>
                            <td class="p-3 text-right">
                                <div class="flex items-center justify-end gap-2">
                                    <button 
                                        class="kai-btn kai-btn-ghost h-8 px-2 text-xs" 
                                        disabled={idx === 0} 
                                        onclick={() => moveProviderPriority(p, 'up')}>
                                        ▲ 위로
                                    </button>
                                    <button 
                                        class="kai-btn kai-btn-ghost h-8 px-2 text-xs" 
                                        disabled={idx === (data.providers?.length || 0) - 1} 
                                        onclick={() => moveProviderPriority(p, 'down')}>
                                        ▼ 아래로
                                    </button>
                                    <button 
                                        class="kai-btn {p.isActive ? 'kai-btn-ghost' : 'kai-btn-primary'} h-8 px-3 text-xs" 
                                        onclick={() => updateOmniProvider(p.id, { isActive: !p.isActive })}>
                                        {p.isActive ? '비활성화' : '활성화'}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                    {#if !data.providers?.length}
                        <tr><td colspan="6" class="p-6 text-center text-kai-faint">등록된 OmniRoute 제공자가 없습니다.</td></tr>
                    {/if}
                </tbody>
            </table>
        </div>
    </div>

    <div class="kai-card p-5">
        <h3 class="font-bold text-base mb-3">최근 라우팅 요청 기록 (Proxy Logs)</h3>
        <div class="overflow-x-auto max-h-72 overflow-y-auto kai-scroll">
            <table class="w-full text-left text-xs">
                <thead class="text-kai-faint sticky top-0 bg-kai-surface border-b border-kai-border-soft">
                    <tr>
                        <th class="p-2">시간</th>
                        <th class="p-2">상태</th>
                        <th class="p-2">제공자/모델</th>
                        <th class="p-2">지연시간</th>
                        <th class="p-2">ID</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-kai-border-soft">
                    {#each (data.proxyLogs || []) as log}
                        <tr>
                            <td class="p-2 text-kai-faint font-mono">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '-'}</td>
                            <td class="p-2">
                                <span class="{log.status === 'success' || log.status === 'ok' ? 'text-kai-ok font-semibold' : 'text-kai-warn'}">
                                    {log.status}
                                </span>
                            </td>
                            <td class="p-2 text-kai-text">{log.level || log.providerKey || 'omniroute'} ({log.levelId || log.upstreamModel || 'auto'})</td>
                            <td class="p-2 text-kai-dim font-mono">{log.latencyMs ? `${log.latencyMs} ms` : '-'}</td>
                            <td class="p-2 text-kai-faint font-mono truncate max-w-xs">{log.id}</td>
                        </tr>
                    {/each}
                    {#if !data.proxyLogs?.length}
                        <tr><td colspan="5" class="p-4 text-center text-kai-faint">최근 라우팅 기록이 없습니다.</td></tr>
                    {/if}
                </tbody>
            </table>
        </div>
    </div>
</div>
{:else if tab==='settings'}<div class="space-y-5">
<form class="kai-card grid gap-4 p-5 sm:grid-cols-2" onsubmit={(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);void saveSettings('site',{name:f.get('name'),tagline:f.get('tagline'),accentColor:f.get('accentColor'),registrationOpen:f.get('registrationOpen')==='on',inviteOnly:f.get('inviteOnly')==='on',nsfwAllowed:f.get('nsfwAllowed')==='on'})}}>
<h2 class="font-bold sm:col-span-2">서비스</h2>
<label class="block text-sm">이름<input name="name" class="kai-input mt-1" value={data.site.name}/></label>
<label class="block text-sm">소개<input name="tagline" class="kai-input mt-1" value={data.site.tagline}/></label>
<label class="block text-sm">포인트 색<input name="accentColor" class="kai-input mt-1" value={data.site.accentColor}/></label>
<div class="flex flex-wrap items-end gap-4 text-sm"><label class="flex gap-2"><input name="registrationOpen" type="checkbox" checked={data.site.registrationOpen}/>회원가입 열기</label><label class="flex gap-2"><input name="inviteOnly" type="checkbox" checked={data.site.inviteOnly}/>초대 전용</label><label class="flex gap-2"><input name="nsfwAllowed" type="checkbox" checked={data.site.nsfwAllowed}/>NSFW 허용</label></div>
<button class="kai-btn kai-btn-primary sm:col-span-2">저장</button>
</form>

<form class="kai-card p-5" onsubmit={(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);void saveSettings('generation',{
    modelAlias:f.get('modelAlias'),
    maxContext:Number(f.get('maxContext')),maxResponse:Number(f.get('maxResponse')),maxHistoryMessages:Number(f.get('maxHistoryMessages')),
    temperature:num(f.get('temperature')),topP:num(f.get('topP')),
    topK:num(f.get('topK')),minP:num(f.get('minP')),topA:num(f.get('topA')),repetitionPenalty:num(f.get('repetitionPenalty')),
    frequencyPenalty:num(f.get('frequencyPenalty')),presencePenalty:num(f.get('presencePenalty')),
    reasoningEffort:Number(f.get('reasoningEffort')),verbosity:Number(f.get('verbosity')),
    thinkingTokens:Number(f.get('thinkingTokens')),seed:num(f.get('seed')),
    streaming:f.get('streaming')==='on',promptPreprocess:f.get('promptPreprocess')==='on',
    jailbreakToggle:f.get('jailbreakToggle')==='on',chainOfThought:f.get('chainOfThought')==='on',
    proofread:{enabled:f.get('proofreadEnabled')==='on',models:csv(f.get('proofreadModels')),
        correctors:csv(f.get('proofreadCorrectors')),languages:csv(f.get('proofreadLanguages'))},
})}}>
<h2 class="font-bold">생성 설정</h2>
<p class="mt-1 text-sm text-kai-dim">데스크톱 RisuAI에서 대화 중 조절하던 값들입니다. KAI 사용자에게는 설정 화면이 없으므로 여기서 전체에 적용됩니다.</p>

<h3 class="mt-5 text-sm font-semibold text-kai-dim">기본</h3>
<div class="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
<label class="block text-sm">라우팅 별칭<input name="modelAlias" class="kai-input mt-1" value={data.generation.modelAlias}/></label>
<label class="block text-sm">문맥 길이<input name="maxContext" type="number" min="1024" class="kai-input mt-1" value={data.generation.maxContext}/></label>
<label class="block text-sm">최대 답변<input name="maxResponse" type="number" min="1" class="kai-input mt-1" value={data.generation.maxResponse}/></label>
<label class="block text-sm">최대 히스토리<input name="maxHistoryMessages" type="number" min="1" class="kai-input mt-1" value={data.generation.maxHistoryMessages}/></label>
</div>

<h3 class="mt-6 text-sm font-semibold text-kai-dim">샘플링</h3>
<p class="mt-1 text-xs text-kai-faint">비워 두면 해당 값을 요청에 아예 보내지 않습니다. 0을 넣는 것과 다릅니다 — 지원하지 않는 파라미터를 보내면 공급자가 요청을 거절할 수 있습니다.</p>
<div class="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
<label class="block text-sm">Temperature<input name="temperature" type="number" step="0.01" min="0" max="2" class="kai-input mt-1" value={data.generation.temperature??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Top P<input name="topP" type="number" step="0.01" min="0" max="1" class="kai-input mt-1" value={data.generation.topP??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Top K<input name="topK" type="number" step="1" min="0" class="kai-input mt-1" value={data.generation.topK??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Min P<input name="minP" type="number" step="0.01" min="0" max="1" class="kai-input mt-1" value={data.generation.minP??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Top A<input name="topA" type="number" step="0.01" min="0" max="1" class="kai-input mt-1" value={data.generation.topA??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Repetition Penalty<input name="repetitionPenalty" type="number" step="0.01" min="0" max="2" class="kai-input mt-1" value={data.generation.repetitionPenalty??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Frequency Penalty<input name="frequencyPenalty" type="number" step="0.01" min="-2" max="2" class="kai-input mt-1" value={data.generation.frequencyPenalty??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Presence Penalty<input name="presencePenalty" type="number" step="0.01" min="-2" max="2" class="kai-input mt-1" value={data.generation.presencePenalty??''} placeholder="사용 안 함"/></label>
<label class="block text-sm">Seed<input name="seed" type="number" step="1" class="kai-input mt-1" value={data.generation.seed??''} placeholder="무작위"/></label>
</div>

<h3 class="mt-6 text-sm font-semibold text-kai-dim">추론</h3>
<div class="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
<label class="block text-sm">Reasoning Effort<select name="reasoningEffort" class="kai-input mt-1">{#each [[-1,'Minimal'],[0,'Low'],[1,'Medium'],[2,'High'],[3,'XHigh']] as o}<option value={o[0]} selected={data.generation.reasoningEffort===o[0]}>{o[1]}</option>{/each}</select></label>
<label class="block text-sm">Verbosity<select name="verbosity" class="kai-input mt-1">{#each [[0,'Low'],[1,'Medium'],[2,'High']] as o}<option value={o[0]} selected={data.generation.verbosity===o[0]}>{o[1]}</option>{/each}</select></label>
<label class="block text-sm">Thinking Tokens<input name="thinkingTokens" type="number" step="1" min="0" class="kai-input mt-1" value={data.generation.thinkingTokens}/></label>
</div>
<p class="mt-2 text-xs text-kai-faint">추론 관련 값은 모델이 지원할 때만 전송됩니다.</p>

<h3 class="mt-6 text-sm font-semibold text-kai-dim">동작</h3>
<div class="mt-2 flex flex-wrap gap-x-6 gap-y-3 text-sm">
<label class="flex gap-2"><input name="streaming" type="checkbox" checked={data.generation.streaming}/>스트리밍</label>
<label class="flex gap-2"><input name="promptPreprocess" type="checkbox" checked={data.generation.promptPreprocess}/>프롬프트 전처리</label>
<label class="flex gap-2"><input name="jailbreakToggle" type="checkbox" checked={data.generation.jailbreakToggle}/>Jailbreak 프롬프트</label>
<label class="flex gap-2"><input name="chainOfThought" type="checkbox" checked={data.generation.chainOfThought}/>Chain of Thought</label>
</div>

<h3 class="mt-6 text-sm font-semibold text-kai-dim">생성 후 문법 교정</h3>
<p class="mt-1 text-xs text-kai-faint">GLM·DeepSeek은 한국어 답변에 한자를 섞고 중국어 어순을 남깁니다. 해당 모델이 답한 턴만 GPT-5.6 → Gemini 3.7 Flash 순으로 다시 한 번 다듬습니다. 교정본이 거절·요약·번역으로 보이면 원문을 그대로 내보냅니다. 대상 모델의 답변은 <b>스트리밍이 아니라 교정이 끝난 뒤 한 번에</b> 표시되고, 턴마다 생성이 한 번 더 일어납니다.</p>
<div class="mt-2 grid gap-4 sm:grid-cols-3">
<label class="block text-sm sm:col-span-3"><span class="flex gap-2"><input name="proofreadEnabled" type="checkbox" checked={data.generation.proofread?.enabled ?? true}/>교정 사용</span></label>
<label class="block text-sm">대상 모델 (쉼표, 부분 일치)<input name="proofreadModels" class="kai-input mt-1" value={(data.generation.proofread?.models ?? []).join(', ')} placeholder="glm, deepseek"/></label>
<label class="block text-sm">교정 모델 별칭 (순서대로)<input name="proofreadCorrectors" class="kai-input mt-1" value={(data.generation.proofread?.correctors ?? []).join(', ')} placeholder="gpt-5-6, gemini-3.7-flash"/></label>
<label class="block text-sm">대상 언어 (비우면 전체)<input name="proofreadLanguages" class="kai-input mt-1" value={(data.generation.proofread?.languages ?? []).join(', ')} placeholder="ko"/></label>
</div>

<button class="kai-btn kai-btn-primary mt-6">저장</button>
</form>
</div>
{:else if tab==='engine'}<div class="space-y-5"><div class="kai-card p-5"><h2 class="font-bold">프롬프트 프리셋</h2><p class="mt-1 text-sm text-kai-dim">RisuAI <code>.risupreset</code> / <code>.risup</code> / <code>.json</code>. 기본으로 지정한 프리셋이 모든 사용자에게 적용됩니다. 프리셋이 들고 있는 생성 설정(문맥 길이·Temperature·샘플러 등)은 <b>서비스 설정</b>의 생성 설정에 함께 반영됩니다. API 키와 외부 URL 필드는 가져올 때 제거합니다.</p><div class="mt-4 flex flex-wrap items-center gap-2"><input type="file" accept=".risupreset,.risup,.json" onchange={(e)=>presetFile=e.currentTarget.files?.[0]??null}/><button class="kai-btn kai-btn-primary" disabled={!presetFile} onclick={()=>importEngineFile('/admin/presets/import',presetFile,(r)=>`${r.name} 적용 (필드 ${r.fields}개)${r.adopted?.length?` · 생성 설정 ${r.adopted.length}개 반영`:''}`)}>가져오기</button></div><div class="mt-4 space-y-2">{#each data.presets as p}<div class="flex flex-wrap items-center gap-3 rounded-xl bg-kai-surface-2 p-3"><div class="min-w-0 flex-1"><p class="truncate font-semibold">{p.name}</p><p class="text-xs text-kai-faint">{p.isDefault?'기본 프리셋':'대기'}</p></div>{#if !p.isDefault}<button class="kai-btn kai-btn-ghost" onclick={()=>patch(`/admin/presets/${p.id}`,{isDefault:true})}>기본으로</button>{/if}<button class="kai-btn kai-btn-ghost" onclick={()=>removeEngine(`/admin/presets/${p.id}`)}>삭제</button></div>{/each}{#if !data.presets.length}<p class="text-sm text-kai-faint">등록된 프리셋이 없습니다. 엔진 기본값을 사용합니다.</p>{/if}</div></div>
<div class="kai-card p-5"><h2 class="font-bold">모듈</h2><p class="mt-1 text-sm text-kai-dim">RisuAI <code>.risum</code>. 정규식·트리거·로어북을 담고 있어, 프리셋이 “모듈 적용 필수”라면 이걸 켜야 화면이 제대로 나옵니다.</p><div class="mt-4 flex flex-wrap items-center gap-2"><input type="file" accept=".risum" onchange={(e)=>moduleFile=e.currentTarget.files?.[0]??null}/><button class="kai-btn kai-btn-primary" disabled={!moduleFile} onclick={()=>importEngineFile('/admin/modules/import',moduleFile,(r)=>`${r.name} ${r.replaced?'갱신':'설치'} (정규식 ${r.regexCount})`)}>가져오기</button></div><div class="mt-4 space-y-2">{#each data.modules as m}<div class="flex flex-wrap items-center gap-3 rounded-xl bg-kai-surface-2 p-3"><div class="min-w-0 flex-1"><p class="truncate font-semibold">{m.name}</p><p class="text-xs text-kai-faint">정규식 {m.regexCount} · 트리거 {m.triggerCount} · 로어 {m.loreCount}{m.namespace?` · ${m.namespace}`:''}{m.lowLevelAccess?' · 저수준 접근 요청':''}</p></div><button class="kai-btn kai-btn-ghost" onclick={()=>patch(`/admin/modules/${m.id}`,{enabled:!m.enabled})}>{m.enabled?'사용 중':'꺼짐'}</button><button class="kai-btn kai-btn-ghost" onclick={()=>removeEngine(`/admin/modules/${m.id}`)}>삭제</button></div>{/each}{#if !data.modules.length}<p class="text-sm text-kai-faint">설치된 모듈이 없습니다.</p>{/if}</div></div>
<div class="kai-card p-5"><h2 class="font-bold">프리셋 옵션</h2><p class="mt-1 text-sm text-kai-dim">프리셋과 모듈이 선언한 선택 항목입니다. 데스크톱 RisuAI에서는 사용자가 대화 사이드바에서 고르지만, 여기서 고른 값이 전체에 적용됩니다.</p>
{#if !data.toggles.spec.length}<p class="mt-4 text-sm text-kai-faint">현재 프리셋과 모듈이 선언한 선택 항목이 없습니다.</p>{:else}
<div class="mt-4 space-y-3">
{#each data.toggles.spec as t}
    {#if t.type==='group'}<h3 class="mt-5 border-b border-kai-border-soft pb-1 text-sm font-bold">{t.label}</h3>
    {:else if t.type==='divider'}<div class="mt-4 flex items-center gap-3 text-xs text-kai-faint">{#if t.label}<span class="shrink-0">{t.label}</span>{/if}<hr class="grow border-kai-border-soft"/></div>
    {:else if t.type==='caption'}<p class="text-xs text-kai-faint">{t.label}</p>
    {:else if t.type==='select'}<label class="flex flex-wrap items-center gap-3 text-sm"><span class="min-w-52">{t.label}</span><select class="kai-input w-64" onchange={(e)=>toggleDraft[t.key]=e.currentTarget.value}><option value="" selected={!toggleDraft[t.key]}>선택 안 함</option>{#each t.options as o,i}<option value={String(i)} selected={toggleDraft[t.key]===String(i)}>{o}</option>{/each}</select></label>
    {:else if t.type==='text'}<label class="flex flex-wrap items-center gap-3 text-sm"><span class="min-w-52">{t.label}</span><input class="kai-input w-64" value={toggleDraft[t.key]??''} oninput={(e)=>toggleDraft[t.key]=e.currentTarget.value}/></label>
    {:else if t.type==='textarea'}<label class="block text-sm"><span>{t.label}</span><textarea class="kai-input mt-1 min-h-24" value={toggleDraft[t.key]??''} oninput={(e)=>toggleDraft[t.key]=e.currentTarget.value}></textarea></label>
    {:else}<label class="flex items-center gap-3 text-sm"><input type="checkbox" checked={toggleDraft[t.key]==='1'} onchange={(e)=>toggleDraft[t.key]=e.currentTarget.checked?'1':'0'}/><span>{t.label}</span></label>
    {/if}
{/each}
</div>
<button class="kai-btn kai-btn-primary mt-5" onclick={saveToggles}>저장</button>
{/if}</div>
<div class="kai-card p-5"><h2 class="font-bold">HypaV3 메모리</h2><p class="mt-1 text-sm text-kai-dim">HypaV3 내보내기 <code>.json</code>. 하나만 적용되며, 등록하면 장기 기억이 켜집니다.</p><div class="mt-4 flex flex-wrap items-center gap-2"><input type="file" accept=".json" onchange={(e)=>hypaFile=e.currentTarget.files?.[0]??null}/><button class="kai-btn kai-btn-primary" disabled={!hypaFile} onclick={()=>importEngineFile('/admin/hypa/import',hypaFile,(r)=>`${r.name} 적용`)}>가져오기</button></div><p class="mt-4 text-sm {data.hypa.installed?'text-kai-text':'text-kai-faint'}">{data.hypa.installed?`적용 중: ${data.hypa.name}`:'등록된 HypaV3 프리셋이 없습니다.'}</p>{#if data.hypa.installed}<button class="kai-btn kai-btn-ghost mt-3" onclick={()=>removeEngine('/admin/hypa')}>해제</button>{/if}</div></div>
{:else if tab==='plugins'}<div class="kai-card mb-5 p-5"><h2 class="font-bold">RisuAI 플러그인 설치</h2><textarea class="kai-input mt-4 min-h-40 font-mono text-xs" bind:value={pluginSource} placeholder="//@name ..."></textarea><button class="kai-btn kai-btn-primary mt-3" disabled={!pluginSource.trim()} onclick={install}>설치</button></div><div class="space-y-2">{#each data as p}<div class="kai-card flex items-center gap-3 p-4"><div class="flex-1"><b>{p.displayName}</b><p class="text-xs text-kai-faint">API {p.apiVersion} · {p.name}</p></div><button class="kai-btn kai-btn-ghost" onclick={()=>patch(`/admin/plugins/${p.id}`,{enabled:!p.enabled})}>{p.enabled?'사용 중':'꺼짐'}</button></div>{/each}</div>
{:else if tab==='users'}<div class="space-y-2">{#each data as u}<div class="kai-card flex flex-wrap items-center gap-3 p-4"><div class="min-w-0 flex-1"><b>{u.displayName}</b><p class="truncate text-xs text-kai-faint">{u.email}</p><p class="mt-1 text-[11px] text-kai-faint">최근 접속 {u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString('ko-KR') : '기록 없음'} · 대화 {u.chatCount.toLocaleString()}개 · 메시지 {u.messageCount.toLocaleString()}개</p></div><span class="kai-chip">{u.role === 'admin' ? '관리자' : '사용자'}</span><span class="kai-chip">{u.status === 'active' ? '활성' : u.status === 'suspended' ? '정지' : '대기'}</span><button class="kai-btn kai-btn-ghost" onclick={()=>editingUser=u}>정보 수정</button></div>{/each}</div>
{:else if tab==='logs'}
<div class="space-y-6">
    <div class="kai-card p-5">
        <h2 class="font-bold text-lg mb-1">최근 접속 유저 목록 (Last Seen)</h2>
        <p class="text-xs text-kai-dim mb-4">가장 최근 서비스에 접속한 사용자 접속 기록입니다.</p>
        <div class="overflow-x-auto kai-scroll max-h-72">
            <table class="w-full text-left text-sm">
                <thead>
                    <tr class="border-b border-kai-border-soft text-xs text-kai-dim">
                        <th class="py-2.5 px-3">사용자</th>
                        <th class="py-2.5 px-3">이메일</th>
                        <th class="py-2.5 px-3">권한</th>
                        <th class="py-2.5 px-3">최근 접속 시각</th>
                    </tr>
                </thead>
                <tbody>
                    {#each (data?.[1] || []).filter((u: any) => u.lastSeenAt).sort((a: any, b: any) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()).slice(0, 30) as u}
                        <tr class="border-b border-kai-border-soft/50 hover:bg-kai-surface-2/50">
                            <td class="py-2.5 px-3 font-semibold">{u.displayName}</td>
                            <td class="py-2.5 px-3 text-kai-dim font-mono text-xs">{u.email}</td>
                            <td class="py-2.5 px-3"><span class="kai-chip">{u.role === 'admin' ? '관리자' : '사용자'}</span></td>
                            <td class="py-2.5 px-3 text-xs">{new Date(u.lastSeenAt).toLocaleString('ko-KR')}</td>
                        </tr>
                    {/each}
                    {#if !(data?.[1]?.filter((u: any) => u.lastSeenAt)?.length)}
                        <tr><td colspan="4" class="py-8 text-center text-kai-faint">접속 기록이 없습니다.</td></tr>
                    {/if}
                </tbody>
            </table>
        </div>
    </div>

    <div class="kai-card p-5">
        <h2 class="font-bold text-lg mb-1">관리자 작업 로그 (Audit Log)</h2>
        <p class="text-xs text-kai-dim mb-4">관리자 변경사항 및 주요 시스템 작업 이력입니다.</p>
        <div class="overflow-x-auto kai-scroll max-h-96">
            <table class="w-full text-left text-xs">
                <thead>
                    <tr class="border-b border-kai-border-soft text-kai-dim">
                        <th class="py-2.5 px-3">일시</th>
                        <th class="py-2.5 px-3">작업자</th>
                        <th class="py-2.5 px-3">작업(Action)</th>
                        <th class="py-2.5 px-3">대상(Target)</th>
                        <th class="py-2.5 px-3">상세 내용</th>
                    </tr>
                </thead>
                <tbody>
                    {#each (data?.[0]?.items || []) as item}
                        <tr class="border-b border-kai-border-soft/50 hover:bg-kai-surface-2/50">
                            <td class="py-2.5 px-3 text-kai-faint font-mono whitespace-nowrap">{new Date(item.createdAt).toLocaleString('ko-KR')}</td>
                            <td class="py-2.5 px-3 font-medium">{item.actorEmail ?? item.actorId ?? 'system'}</td>
                            <td class="py-2.5 px-3"><span class="rounded bg-kai-surface-2 px-1.5 py-0.5 font-mono">{item.action}</span></td>
                            <td class="py-2.5 px-3 text-kai-dim">{item.target ?? '-'}</td>
                            <td class="py-2.5 px-3 font-mono text-[11px] max-w-md truncate">{JSON.stringify(item.detail)}</td>
                        </tr>
                    {/each}
                    {#if !(data?.[0]?.items?.length)}
                        <tr><td colspan="5" class="py-8 text-center text-kai-faint">기록된 작업 로그가 없습니다.</td></tr>
                    {/if}
                </tbody>
            </table>
        </div>
    </div>
</div>
{/if}</div></main></div>

{#if editingCharacterId}
    <CharacterEditor
        characterId={editingCharacterId}
        onclose={() => editingCharacterId = null}
        onsaved={async () => { await load(); await appConfig.load() }}
        ondeleted={async () => { await load(); await appConfig.load() }}
    />
{/if}

{#if editingUser}
    <UserEditor
        user={editingUser}
        onclose={() => editingUser = null}
        onsaved={async () => { editingUser = null; await load() }}
    />
{/if}
