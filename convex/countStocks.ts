import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { accountActive, requireActiveAccount } from './accountAccess';

const MAX_STOCKS = 80;

export const list = query({
    args: {},
    handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity || !(await accountActive(ctx, identity.subject))) return [];

        const rows = await ctx.db
            .query("countStocks")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();
        rows.sort((a, b) => b.savedAt - a.savedAt);
        return rows.slice(0, MAX_STOCKS);
    },
});

export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, { text: raw }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);

        if (!raw.trim()) throw new Error("Empty text");

        const all = await ctx.db
            .query("countStocks")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();

        for (const d of all) {
            if (d.text === raw) {
                await ctx.db.delete(d._id);
            }
        }

        await ctx.db.insert("countStocks", {
            userId: identity.subject,
            text: raw,
            savedAt: Date.now(),
        });

        const after = await ctx.db
            .query("countStocks")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();
        after.sort((a, b) => b.savedAt - a.savedAt);
        for (const d of after.slice(MAX_STOCKS)) {
            await ctx.db.delete(d._id);
        }
    },
});

export const remove = mutation({
    args: { id: v.id("countStocks") },
    handler: async (ctx, { id }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);

        const doc = await ctx.db.get(id);
        if (!doc || doc.userId !== identity.subject) throw new Error("Not found");

        await ctx.db.delete(id);
    },
});

/** 未ログイン時の localStorage から、同名テキストはより新しい savedAt を採用してマージ */
export const mergeLocalStocks = mutation({
    args: {
        entries: v.array(
            v.object({
                text: v.string(),
                savedAt: v.number(),
            }),
        ),
    },
    handler: async (ctx, { entries }) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) throw new Error("Unauthorized");
        await requireActiveAccount(ctx, identity.subject);

        if (entries.length === 0) return;

        const cloud = await ctx.db
            .query("countStocks")
            .withIndex("by_user", (q) => q.eq("userId", identity.subject))
            .collect();

        const best: Map<string, number> = new Map();
        for (const d of cloud) {
            best.set(d.text, d.savedAt);
        }
        for (const e of entries) {
            const prev = best.get(e.text);
            if (prev === undefined || e.savedAt > prev) {
                best.set(e.text, e.savedAt);
            }
        }

        for (const d of cloud) {
            await ctx.db.delete(d._id);
        }

        const merged = [...best.entries()]
            .map(([text, savedAt]) => ({ text, savedAt }))
            .sort((a, b) => b.savedAt - a.savedAt)
            .slice(0, MAX_STOCKS);

        for (const m of merged) {
            await ctx.db.insert("countStocks", {
                userId: identity.subject,
                text: m.text,
                savedAt: m.savedAt,
            });
        }
    },
});
