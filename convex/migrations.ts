import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { mergeRows } from "./sync";

/*
 * Clerk を開発用から本番用へ移すと、同じ人でもユーザー ID が変わる。
 * 古い ID で預かっているものを新しい ID へ付け替える。
 *
 *   npx convex run migrations:moveUser '{"from":"user_古い","to":"user_新しい"}' --prod
 *
 * 新しい ID で先にサインインしていて同じアイテムが両方にあるときは、
 * 同期と同じ規則で欄ごとに合わせて、古い方の行を消す。何度流しても同じ結果になる。
 */
export const moveUser = internalMutation({
    args: { from: v.string(), to: v.string() },
    handler: async (ctx, { from, to }) => {
        if (!from || !to || from === to) throw new Error("from と to に別々の ID を渡す");

        let moved = 0;
        let merged = 0;

        const rows = await ctx.db
            .query("syncItems")
            .withIndex("by_user", (q) => q.eq("userId", from))
            .collect();
        for (const row of rows) {
            const existing = await ctx.db
                .query("syncItems")
                .withIndex("by_user_item", (q) => q.eq("userId", to).eq("itemId", row.itemId))
                .unique();
            if (!existing) {
                await ctx.db.patch(row._id, { userId: to });
                moved += 1;
                continue;
            }
            const result = mergeRows(existing, row);
            if (result) {
                await ctx.db.patch(existing._id, result);
            } else if (row.updatedAt > existing.updatedAt) {
                await ctx.db.patch(existing._id, {
                    updatedAt: row.updatedAt,
                    deletedAt: row.deletedAt,
                    payload: row.payload,
                });
            }
            await ctx.db.delete(row._id);
            merged += 1;
        }

        const stocks = await ctx.db
            .query("countStocks")
            .withIndex("by_user", (q) => q.eq("userId", from))
            .collect();
        for (const stock of stocks) await ctx.db.patch(stock._id, { userId: to });

        return { moved, merged, countStocks: stocks.length };
    },
});
