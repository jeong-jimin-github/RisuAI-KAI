<script lang="ts">
    import type { SystemStatus } from '@kai/shared/contract'
    import {
        Activity,
        BatteryMedium,
        Clock3,
        Cpu,
        HardDrive,
        MemoryStick,
        RefreshCw,
        Server,
        Thermometer,
        Zap,
    } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { api } from '../api/client'

    let { embedded = false }: { embedded?: boolean } = $props()

    let status = $state<SystemStatus | null>(null)
    let loading = $state(true)
    let refreshing = $state(false)
    let error = $state('')

    const formatBytes = (bytes: number | null | undefined) => {
        if (bytes === null || bytes === undefined) return '—'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let value = bytes, unit = 0
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
        return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`
    }
    const formatPct = (value: number | null | undefined) => value === null || value === undefined ? '측정 중' : `${value.toFixed(1)}%`
    const formatTemp = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${value.toFixed(1)}°C`
    const formatDuration = (seconds: number) => {
        const days = Math.floor(seconds / 86400)
        const hours = Math.floor((seconds % 86400) / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        return days ? `${days}일 ${hours}시간` : hours ? `${hours}시간 ${minutes}분` : `${minutes}분`
    }
    const batteryDetail = (value: SystemStatus['battery']) => {
        const parts = [value.status, value.health, value.plugged].filter(Boolean)
        if (parts.length) return parts.join(' · ')
        return value.source === 'thermal' ? '온도 센서만 사용 가능' : 'Termux:API 연결 필요'
    }

    async function refresh() {
        if (refreshing) return
        refreshing = true
        try {
            status = await api.status()
            error = ''
        } catch (caught) {
            error = caught instanceof Error ? caught.message : '상태를 불러오지 못했습니다.'
        } finally {
            loading = false
            refreshing = false
        }
    }

    onMount(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), 5_000)
        return () => clearInterval(timer)
    })
</script>

<div class={embedded ? 'w-full' : 'mx-auto w-full max-w-6xl px-5 py-10 md:px-8 md:py-14'}>
    <header class="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
            <h1 class="kai-page-title">서버 상태</h1>
            <p class="mt-3 text-sm text-kai-dim">Termux 호스트의 리소스와 장치 상태를 5초마다 갱신합니다.</p>
        </div>
        <button class="kai-btn kai-btn-ghost" disabled={refreshing} onclick={refresh}>
            <RefreshCw size={16} class={refreshing ? 'animate-spin' : undefined} /> 새로고침
        </button>
    </header>

    {#if error}
        <div class="mb-5 rounded-kai border border-kai-danger/30 bg-kai-danger/10 px-4 py-3 text-sm text-kai-danger">{error}</div>
    {/if}

    {#if loading && !status}
        <div class="kai-card flex min-h-72 items-center justify-center text-kai-faint">서버 정보를 측정하는 중…</div>
    {:else if status}
        <section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="핵심 리소스">
            <article class="kai-card p-5">
                <div class="mb-5 flex items-center justify-between text-kai-dim"><span class="text-sm font-semibold">CPU</span><Cpu size={20} /></div>
                <strong class="text-3xl tracking-tight">{formatPct(status.cpu.usagePct)}</strong>
                <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-kai-surface-3"><span class="block h-full rounded-full bg-kai-accent transition-all" style:width={`${status.cpu.usagePct ?? 0}%`}></span></div>
                <p class="mt-3 text-xs text-kai-faint">{status.cpu.cores}코어 · Load {status.cpu.loadAverage.join(' / ')}</p>
            </article>
            <article class="kai-card p-5">
                <div class="mb-5 flex items-center justify-between text-kai-dim"><span class="text-sm font-semibold">메모리</span><MemoryStick size={20} /></div>
                <strong class="text-3xl tracking-tight">{formatPct(status.memory.usedPct)}</strong>
                <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-kai-surface-3"><span class="block h-full rounded-full bg-kai-accent transition-all" style:width={`${status.memory.usedPct}%`}></span></div>
                <p class="mt-3 text-xs text-kai-faint">{formatBytes(status.memory.usedBytes)} / {formatBytes(status.memory.totalBytes)}</p>
            </article>
            <article class="kai-card p-5">
                <div class="mb-5 flex items-center justify-between text-kai-dim"><span class="text-sm font-semibold">저장공간</span><HardDrive size={20} /></div>
                <strong class="text-3xl tracking-tight">{status.disk ? formatPct(status.disk.usedPct) : '—'}</strong>
                <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-kai-surface-3"><span class="block h-full rounded-full bg-kai-accent transition-all" style:width={`${status.disk?.usedPct ?? 0}%`}></span></div>
                <p class="mt-3 text-xs text-kai-faint">{status.disk ? `${formatBytes(status.disk.availableBytes)} 사용 가능` : '정보를 읽을 수 없음'}</p>
            </article>
            <article class="kai-card p-5">
                <div class="mb-5 flex items-center justify-between text-kai-dim"><span class="text-sm font-semibold">최고 온도</span><Thermometer size={20} /></div>
                <strong class="text-3xl tracking-tight">{formatTemp(status.temperatures.highestC)}</strong>
                <p class="mt-4 text-xs text-kai-faint">CPU {formatTemp(status.temperatures.cpuC)} · GPU {formatTemp(status.temperatures.gpuC)}</p>
                <p class="mt-2 text-xs text-kai-faint">배터리 {formatTemp(status.temperatures.batteryC)}</p>
            </article>
        </section>

        <section class="mt-4 grid gap-4 lg:grid-cols-2">
            <article class="kai-card p-5 md:p-6">
                <div class="mb-6 flex items-center gap-3"><span class="grid size-10 place-items-center rounded-full bg-kai-accent-soft text-kai-accent"><BatteryMedium size={21} /></span><div><h2 class="font-bold">배터리</h2><p class="text-xs text-kai-faint">{batteryDetail(status.battery)}</p></div></div>
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div class="rounded-kai bg-kai-surface-2 p-3"><p class="text-xs text-kai-faint">잔량</p><b class="mt-1 block">{status.battery.levelPct === null ? '—' : `${status.battery.levelPct}%`}</b></div>
                    <div class="rounded-kai bg-kai-surface-2 p-3"><p class="text-xs text-kai-faint">온도</p><b class="mt-1 block">{formatTemp(status.battery.temperatureC)}</b></div>
                    <div class="rounded-kai bg-kai-surface-2 p-3"><p class="text-xs text-kai-faint">전압</p><b class="mt-1 block">{status.battery.voltageV === null ? '—' : `${status.battery.voltageV} V`}</b></div>
                    <div class="rounded-kai bg-kai-surface-2 p-3"><p class="text-xs text-kai-faint">전류</p><b class="mt-1 block">{status.battery.currentMa === null ? '—' : `${status.battery.currentMa} mA`}</b></div>
                </div>
            </article>

            <article class="kai-card p-5 md:p-6">
                <div class="mb-6 flex items-center gap-3"><span class="grid size-10 place-items-center rounded-full bg-kai-accent-soft text-kai-accent"><Server size={21} /></span><div><h2 class="font-bold">프로세스</h2><p class="text-xs text-kai-faint">서비스 런타임 상태</p></div></div>
                <div class="space-y-4 text-sm">
                    <div class="flex items-center justify-between gap-4"><span class="flex items-center gap-2 text-kai-dim"><Clock3 size={16} /> 시스템 가동</span><b>{formatDuration(status.uptime.systemSeconds)}</b></div>
                    <div class="flex items-center justify-between gap-4"><span class="flex items-center gap-2 text-kai-dim"><Activity size={16} /> 서버 가동</span><b>{formatDuration(status.uptime.processSeconds)}</b></div>
                    <div class="flex items-center justify-between gap-4"><span class="flex items-center gap-2 text-kai-dim"><Zap size={16} /> 프로세스 RSS</span><b>{formatBytes(status.memory.processRssBytes)}</b></div>
                </div>
            </article>
        </section>

        <section class="kai-card mt-4 overflow-hidden">
            <div class="border-b border-kai-border-soft px-5 py-4"><h2 class="font-bold">온도 센서</h2><p class="mt-1 text-xs text-kai-faint">유효한 센서 {status.temperatures.sensors.length}개 · 높은 온도순</p></div>
            <div class="grid gap-px bg-kai-border-soft sm:grid-cols-2 lg:grid-cols-3">
                {#each status.temperatures.sensors as sensor}
                    <div class="flex items-center justify-between bg-kai-surface px-5 py-3 text-sm"><span class="truncate pr-4 text-kai-dim">{sensor.name}</span><b>{formatTemp(sensor.temperatureC)}</b></div>
                {/each}
            </div>
        </section>

        <p class="mt-4 text-right text-xs text-kai-faint">마지막 측정: {new Date(status.sampledAt).toLocaleString('ko-KR')}</p>
    {/if}
</div>
