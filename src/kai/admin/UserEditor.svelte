<script lang="ts">
    import type { AdminUserRow, UserRole, UserStatus } from '@kai/shared/contract'
    import { X } from '@lucide/svelte'
    import { apiPatch } from '../api/client'
    import { toasts } from '../stores/app.svelte'

    let {
        user,
        onclose,
        onsaved,
    }: {
        user: AdminUserRow
        onclose: () => void
        onsaved: (updated: AdminUserRow) => void | Promise<void>
    } = $props()

    let displayName = $state('')
    let email = $state('')
    let role = $state<UserRole>('user')
    let status = $state<UserStatus>('active')
    let newPassword = $state('')
    let saving = $state(false)
    let draftUserId = $state('')

    $effect(() => {
        if (draftUserId === user.id) return
        draftUserId = user.id
        displayName = user.displayName
        email = user.email
        role = user.role
        status = user.status
        newPassword = ''
    })

    function formatDate(value: string | number) {
        const date = new Date(typeof value === 'number' ? value * 1000 : value)
        return date.toLocaleDateString('ko-KR')
    }

    async function save(event: SubmitEvent) {
        event.preventDefault()
        if (!displayName.trim() || !email.trim() || saving) return
        saving = true
        try {
            const payload: any = {
                displayName: displayName.trim(),
                email: email.trim(),
                role,
                status,
            }
            if (newPassword.trim()) {
                payload.password = newPassword.trim()
            }
            const updated = await apiPatch<AdminUserRow>(`/admin/users/${user.id}`, payload)
            toasts.success('사용자 정보를 수정했습니다.')
            await onsaved(updated)
        } catch (error) {
            toasts.error(error)
        } finally {
            saving = false
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && !saving) onclose()
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="presentation" onclick={(event) => event.target === event.currentTarget && !saving && onclose()}>
    <div class="kai-card w-full max-w-lg p-5 shadow-2xl md:p-7" role="dialog" aria-modal="true" aria-labelledby="kai-user-editor-title">
    <form onsubmit={save}>
        <header class="flex items-start justify-between gap-4">
            <div>
                <p class="kai-eyebrow">USER MANAGEMENT</p>
                <h2 id="kai-user-editor-title" class="mt-2 text-xl font-black">사용자 정보 수정</h2>
                <p class="mt-1 text-xs text-kai-faint">가입일 {formatDate(user.createdAt)}</p>
            </div>
            <button type="button" class="kai-icon-action" aria-label="닫기" disabled={saving} onclick={onclose}><X size={18} /></button>
        </header>

        <div class="mt-6 grid gap-4 sm:grid-cols-2">
            <label class="kai-field-label sm:col-span-2">
                표시 이름
                <input class="kai-input" bind:value={displayName} maxlength="40" autocomplete="off" required />
            </label>
            <label class="kai-field-label sm:col-span-2">
                이메일
                <input class="kai-input" type="email" bind:value={email} maxlength="254" autocomplete="off" required />
            </label>
            <label class="kai-field-label sm:col-span-2">
                비밀번호 재설정 <i>(변경 시에만 입력, 6자 이상)</i>
                <input class="kai-input" type="password" bind:value={newPassword} minlength="6" maxlength="128" placeholder="새 비밀번호 입력" autocomplete="new-password" />
            </label>
            <label class="kai-field-label">
                권한
                <select class="kai-input" bind:value={role}>
                    <option value="user">일반 사용자</option>
                    <option value="admin">관리자</option>
                </select>
            </label>
            <label class="kai-field-label">
                상태
                <select class="kai-input" bind:value={status}>
                    <option value="active">활성</option>
                    <option value="suspended">정지</option>
                    <option value="pending">대기</option>
                </select>
            </label>
        </div>

        <div class="mt-6 flex justify-end gap-2 border-t border-kai-border-soft pt-5">
            <button type="button" class="kai-btn kai-btn-ghost" disabled={saving} onclick={onclose}>취소</button>
            <button class="kai-btn kai-btn-primary" disabled={saving || !displayName.trim() || !email.trim()}>{saving ? '저장 중…' : '변경사항 저장'}</button>
        </div>
    </form>
    </div>
</div>
