<script lang="ts">
    import { ArrowRight } from '@lucide/svelte'
    import { router } from '../lib/router.svelte'
    import { appConfig, session, toasts } from '../stores/app.svelte'
    let displayName = $state(''), email = $state(''), password = $state(''), inviteCode = $state(''), busy = $state(false)
    async function submit(event: SubmitEvent) { event.preventDefault(); busy = true; try { await session.register({ displayName, email, password, inviteCode: inviteCode || undefined }); router.go('/') } catch (error) { toasts.error(error) } finally { busy = false } }
</script>

<div class="kai-auth-shell">
    <div class="kai-auth-panel">
        <a href="/" class="kai-auth-brand"><img class="kai-wordmark-mark" src={appConfig.site?.logoUrl || '/kai-logo.png?v=2'} alt="" aria-hidden="true" />{appConfig.site?.name ?? 'RisuAI-KAI'}</a>
        <div class="kai-card kai-auth-card">
            <h1>회원가입</h1>
            {#if appConfig.site?.registrationOpen}
                <form onsubmit={submit}>
                    <label>대화명<input class="kai-input" bind:value={displayName} required maxlength="40" placeholder="불리고 싶은 이름" /></label>
                    <label>이메일<input class="kai-input" type="email" bind:value={email} required placeholder="name@example.com" /></label>
                    <label>비밀번호<input class="kai-input" type="password" bind:value={password} required minlength="8" placeholder="8자 이상" /></label>
                    {#if appConfig.site?.inviteOnly}<label>초대 코드<input class="kai-input" bind:value={inviteCode} required /></label>{/if}
                    <button class="kai-btn kai-btn-primary w-full" disabled={busy}>{busy ? '가입 중…' : '시작하기'}<ArrowRight size={17} /></button>
                </form>
            {:else}<p class="kai-registration-closed">현재는 새 회원을 받고 있지 않습니다.</p>{/if}
            <p class="kai-auth-switch">계정이 있나요? <a href="/login">로그인</a></p>
        </div>
    </div>
</div>
