<script lang="ts">
    import { appConfig } from '../stores/app.svelte'
</script>

<footer class="kai-site-footer">
    <div class="kai-footer-mark">{appConfig.site?.name ?? 'RisuAI-KAI'}</div>
    <p>{appConfig.site?.tagline ?? 'AI 캐릭터와 나누는 특별한 대화.'}</p>
    <p>© {new Date().getFullYear()} {appConfig.site?.name ?? 'RisuAI-KAI'}. All rights reserved.</p>
</footer>
