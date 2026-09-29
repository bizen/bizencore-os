import type { MutationCtx } from "./_generated/server";
import { coerceAttachments, liveAttachments } from "../src/lib/attachments";

/** 同期後も参照が残っているファイルは保ち、外されたものだけ実体を消す。 */
export async function cleanupFiles(
    ctx: MutationCtx,
    userId: string,
    itemId: string,
    attachments: unknown,
    itemDeleted: boolean
): Promise<void> {
    const owners = await ctx.db.query("fileOwners")
        .withIndex("by_user_item", (q) => q.eq("userId", userId).eq("itemId", itemId))
        .collect();
    if (owners.length === 0) return;

    const live = liveAttachments(coerceAttachments(attachments));
    for (const owner of owners) {
        if (!itemDeleted && live.some((att) =>
            att.id === owner.attachmentId && att.kind === "file" && att.storageId === owner.storageId
        )) continue;
        await ctx.storage.delete(owner.storageId);
        await ctx.db.delete(owner._id);
    }
}
