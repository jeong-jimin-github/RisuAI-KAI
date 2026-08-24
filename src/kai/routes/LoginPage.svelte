<script lang="ts">
    import { ArrowRight } from '@lucide/svelte'
    import { router } from '../lib/router.svelte'
    import { appConfig, session, toasts } from '../stores/app.svelte'
    let email = $state(''), password = $state(''), busy = $state(false)
    async function submit(event: SubmitEvent) { event.preventDefault(); busy = true; try { await session.login(email, password); router.go(router.current.query.get('next') || '/') } catch (error) { toasts.error(error) } finally { busy = false } }
</script>

<div class="kai-auth-shell">
    <div class="kai-auth-panel">
        <a href="/" class="kai-auth-brand"><img class="kai-wordmark-mark" src={appConfig.site?.logoUrl || '/kai-logo.png?v=2'} alt="" aria-hidden="true" />{appConfig.site?.name ?? 'RisuAI-KAI'}</a>
        <div class="kai-card kai-auth-card">
            <h1>로그인</h1>
            <form onsubmit={submit}>
                <label>이메일<input class="kai-input" type="email" bind:value={email} required autocomplete="email" placeholder="name@example.com" /></label>
                <label>비밀번호<input class="kai-input" type="password" bind:value={password} required autocomplete="current-password" placeholder="비밀번호 입력" /></label>
                <button class="kai-btn kai-btn-primary w-full" disabled={busy}>{busy ? '로그인 중…' : '로그인'}<ArrowRight size={17} /></button>
            </form>
            <p class="kai-auth-switch">처음인가요? <a href="/register">회원가입</a></p>
        </div>
    </div>
</div>
