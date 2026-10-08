import { v } from 'convex/values';

export const lifeEntryFields = {
  id: v.string(), text: v.string(), note: v.string(), startDate: v.string(),
  repeat: v.union(v.literal('once'), v.literal('daily'), v.literal('weekdays')),
  order: v.number(), updatedAt: v.number(), deletedAt: v.optional(v.number()),
  locked: v.optional(v.boolean()),
  parentId: v.optional(v.union(v.string(), v.null())),
  stamps: v.optional(v.object({ text: v.optional(v.number()), note: v.optional(v.number()),
    schedule: v.optional(v.number()), order: v.optional(v.number()), deletion: v.optional(v.number()), lock: v.optional(v.number()), hierarchy: v.optional(v.number()) })),
};
export const lifePreferenceFields = {
  showInAll: v.boolean(), beforeId: v.union(v.string(), v.null()), updatedAt: v.number(),
  visibilityStamp: v.number(), placementStamp: v.number(),
};
export const lifeCheckFields = {
  entryId: v.string(), date: v.string(), done: v.boolean(), updatedAt: v.number(),
};
