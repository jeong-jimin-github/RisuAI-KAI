type HostedAssets = Record<string, string>

type CharacterAsset = {
    type?: string
    uri?: string
    name?: string
    ext?: string
}

function normaliseReference(reference: string): string[] {
    const values = new Set<string>([reference, reference.replaceAll('\\', '/')])
    for (const value of [...values]) {
        values.add(value.replace(/^embed+ed:\/\//i, ''))
        values.add(value.replace(/^__asset:/i, ''))
        values.add(value.replace(/^\.?\//, ''))
    }
    return [...values]
}

function resolveReference(reference: unknown, hosted: HostedAssets): string {
    if (typeof reference !== 'string' || !reference) return ''
    for (const candidate of normaliseReference(reference)) {
        if (hosted[candidate]) return hosted[candidate]
    }
    return reference
}

function fileParts(reference: string) {
    const clean = reference.replaceAll('\\', '/').split(/[?#]/, 1)[0]
    const file = clean.slice(clean.lastIndexOf('/') + 1)
    const dot = file.lastIndexOf('.')
    return {
        name: dot > 0 ? file.slice(0, dot) : file,
        ext: dot > 0 ? file.slice(dot + 1).toLowerCase() : 'unknown',
    }
}

function assetKind(reference: string) {
    const parts = reference.replaceAll('\\', '/').split('/')
    return parts[0] === 'assets' ? parts[1] : ''
}

/**
 * Reconnects asset references inside a Risu character card to KAI's hosted
 * asset URLs. Older KAI imports kept the files but lost CCv3's asset arrays,
 * so missing lists are also reconstructed from stock CHARX paths.
 */
export function hydrateHostedCharacterAssets<T extends Record<string, any>>(
    original: T,
    hosted: HostedAssets,
): T {
    // The caller's card type is only ever a loose record; widening it here keeps
    // the generic return type without fighting TypeScript over each field.
    const card = original as Record<string, any>
    const risuExtension = card.extentions?.risuai ?? card.extensions?.risuai ?? {}

    if (!Array.isArray(card.additionalAssets) && Array.isArray(risuExtension.additionalAssets)) {
        card.additionalAssets = structuredClone(risuExtension.additionalAssets)
    }
    if (!Array.isArray(card.emotionImages) && Array.isArray(risuExtension.emotions)) {
        card.emotionImages = structuredClone(risuExtension.emotions)
    }

    card.additionalAssets = Array.isArray(card.additionalAssets)
        ? card.additionalAssets
              .filter((asset: unknown) => Array.isArray(asset) && typeof asset[0] === 'string')
              .map((asset: [string, string, string?]) => [
                  asset[0],
                  resolveReference(asset[1], hosted),
                  asset[2] ?? fileParts(asset[1] ?? '').ext,
              ])
        : []
    card.emotionImages = Array.isArray(card.emotionImages)
        ? card.emotionImages
              .filter((asset: unknown) => Array.isArray(asset) && typeof asset[0] === 'string')
              .map((asset: [string, string]) => [asset[0], resolveReference(asset[1], hosted)])
        : []
    card.ccAssets = Array.isArray(card.ccAssets)
        ? card.ccAssets.map((asset: CharacterAsset) => ({
              ...asset,
              uri: resolveReference(asset.uri, hosted),
          }))
        : []

    const additionalNames = new Set(card.additionalAssets.map((asset: string[]) => asset[0].toLowerCase()))
    const emotionNames = new Set(card.emotionImages.map((asset: string[]) => asset[0].toLowerCase()))

    for (const [reference, url] of Object.entries(hosted)) {
        const { name, ext } = fileParts(reference)
        if (!name) continue

        const kind = assetKind(reference)
        if (kind === 'icon') {
            if (/\/main\.[^/]+$/i.test(reference) && !card.image) card.image = url
            continue
        }
        if (kind === 'emotion') {
            if (!emotionNames.has(name.toLowerCase())) {
                card.emotionImages.push([name, url])
                emotionNames.add(name.toLowerCase())
            }
            continue
        }
        if (!additionalNames.has(name.toLowerCase())) {
            card.additionalAssets.push([name, url, ext])
            additionalNames.add(name.toLowerCase())
        }
    }

    card.image = resolveReference(card.image, hosted)
    return original
}

