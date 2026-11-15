export function grokBotConfig() {
    try {
        const { userId, labelId, token, webhookUrl, webhookKey } = JSON.parse(process.env.GROK_BOT_PILOT ?? 'null');
        if (typeof userId !== 'string' || !userId || typeof labelId !== 'string' || !labelId ||
            typeof token !== 'string' || !/^[\w-]{43,128}$/.test(token) ||
            typeof webhookUrl !== 'string' || typeof webhookKey !== 'string' || !webhookKey) return null;
        const url = new URL(webhookUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
        return { userId, labelId, token, webhookUrl: url.href, webhookKey };
    } catch {
        return null;
    }
}
