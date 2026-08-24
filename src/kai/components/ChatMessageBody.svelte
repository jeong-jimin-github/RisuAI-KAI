<script lang="ts">
    import ChatBody from '../../lib/ChatScreens/ChatBody.svelte'
    import { risuChatParser } from '../../ts/process/scripts'
    import { findCharacterbyId } from '../../ts/util'

    interface Props {
        message: string
        role: 'user' | 'char'
        index: number
        characterId: string
        speakerName: string
        revision?: number
        streaming?: boolean
    }

    let {
        message,
        role,
        index,
        characterId,
        speakerName,
        revision = 0,
        streaming = false,
    }: Props = $props()

    let bodyRoot = $state<HTMLElement | null>(null)
    let translated = $state(false)
    let translating = $state(false)
    let retranslate = $state(false)
    let firstMessage = $derived(index === 0 && role === 'char')
    let conditions = $derived({ firstmsg: firstMessage, chatRole: role })
    let char = $derived(findCharacterbyId(characterId))
    let parsedMessage = $derived.by(() => {
        revision
        return risuChatParser(message, {
            chara: char,
            chatID: index,
            rmVar: true,
            visualize: true,
            cbsConditions: conditions,
        })
    })

</script>

<span
    class="kai-risu-message chattext prose max-w-none min-w-0 break-words dark:prose-invert"
    bind:this={bodyRoot}
>
    <ChatBody
        character={char as any}
        {firstMessage}
        idx={index}
        msgDisplay={parsedMessage}
        name={speakerName}
        {bodyRoot}
        modelShortName=""
        {role}
        bind:translated
        bind:translating
        bind:retranslate
        renderRawStreaming={false}
        rawStreamingText={message}
    />
</span>
