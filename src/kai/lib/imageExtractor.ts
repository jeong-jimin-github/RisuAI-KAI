import type { CharacterDetail } from '@kai/shared/contract'

export function isThumbnailRefKey(refKey: string): boolean {
    const k = refKey.trim().toLowerCase()
    const cleanKey = k.split('?')[0].split('#')[0]
    const baseName = cleanKey.split('/').pop() ?? cleanKey
    const nameWithoutExt = baseName.replace(/\.(png|jpe?g|webp|gif|svg|bmp)$/i, '')
    return ['icon', 'avatar', 'main', 'cover', 'thumbnail', 'chara', 'card', 'image', '0', 'image_0', 'main_image'].includes(nameWithoutExt)
}

export function extractImageUrlsFromCharacter(
    char: CharacterDetail | null | undefined | { card?: any; assets?: Record<string, string>; avatarUrl?: string; avatarAssetId?: string; description?: any; creatorNotes?: string }
): string[] {
    if (!char) return []
    const urls = new Set<string>()

    const avatarUrl = 'avatarUrl' in char ? char.avatarUrl : null
    const avatarAssetId = (char as any)?.avatarAssetId

    if (char.assets) {
        for (const [key, url] of Object.entries(char.assets)) {
            if (url && typeof url === 'string') {
                if (avatarAssetId && url.includes(avatarAssetId)) continue
                if (avatarUrl && url === avatarUrl) continue
                if (isThumbnailRefKey(key)) continue
                urls.add(url)
            }
        }
    }

    const extractFromText = (text: unknown) => {
        if (!text || typeof text !== 'string') return

        const mdRegex = /!\[.*?\]\((https?:\/\/[^\s\)]+|\/api\/assets\/[^\s\)]+)\)/gi
        let match: RegExpExecArray | null
        while ((match = mdRegex.exec(text)) !== null) {
            if (match[1]) urls.add(match[1].trim())
        }

        const htmlRegex = /<img\s+[^>]*src=["'](https?:\/\/[^"']+|\/api\/assets\/[^"']+)["'][^>]*>/gi
        while ((match = htmlRegex.exec(text)) !== null) {
            if (match[1]) urls.add(match[1].trim())
        }

        const urlRegex = /(https?:\/\/[^\s"'<>\)]+|\/api\/assets\/[^\s"'<>\)]+)/gi
        while ((match = urlRegex.exec(text)) !== null) {
            const url = match[1].trim()
            const cleanUrl = url.split('?')[0].split('#')[0]
            if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(cleanUrl) || /\/api\/assets\//i.test(url)) {
                urls.add(url)
            }
        }
    }

    if (char.description) extractFromText(typeof char.description === 'string' ? char.description : JSON.stringify(char.description))
    if (char.creatorNotes) extractFromText(char.creatorNotes)

    const walk = (obj: unknown) => {
        if (!obj) return
        if (typeof obj === 'string') {
            extractFromText(obj)
        } else if (Array.isArray(obj)) {
            for (const item of obj) walk(item)
        } else if (typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
                if (['img', 'avatar', 'avatarUrl', 'avatarAssetId', 'mainImage', 'icon', 'cover'].includes(key)) continue
                walk(value)
            }
        }
    }

    if (char.card) {
        walk(char.card)
    }

    if (avatarUrl) {
        urls.delete(avatarUrl)
    }
    if (avatarAssetId) {
        urls.delete(`/api/assets/${avatarAssetId}`)
    }

    return Array.from(urls).filter((url) => {
        const cleanUrl = url.split('?')[0].split('#')[0]
        const fileName = cleanUrl.split('/').pop() ?? ''
        return !isThumbnailRefKey(fileName)
    })
}
