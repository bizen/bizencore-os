import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { ConvexError, v } from 'convex/values';
import { partnerLabels, publicPartnerItems } from '../src/lib/partnerModel';
import { accountActive, requireActiveAccount } from './accountAccess';

const account = async (ctx: QueryCtx, userId: string) => (await accountActive(ctx, userId))
  ? ctx.db.query('partnerAccounts').withIndex('by_user', q => q.eq('userId', userId)).unique() : null;
const source = (ctx: QueryCtx, userId: string) => ctx.db.query('syncItems').withIndex('by_user', q => q.eq('userId', userId)).collect();

async function identity(ctx: QueryCtx, accountId: string) {
  const user = await ctx.auth.getUserIdentity();
  if (!user || user.subject !== accountId) throw new ConvexError('サインインを確認してください。');
  await requireActiveAccount(ctx, accountId);
  return user;
}

async function clearInvites(ctx: MutationCtx, userId: string) {
  const invites = await ctx.db.query('partnerInvites').withIndex('by_owner', q => q.eq('ownerId', userId)).collect();
  for (const invite of invites) await ctx.db.delete(invite._id);
}

export const state = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || user.subject !== accountId || !(await accountActive(ctx, accountId))) return null;
    const own = await account(ctx, accountId);
    const peer = own?.partnerId ? await account(ctx, own.partnerId) : null;
    const labels = partnerLabels(await source(ctx, accountId));
    const invites = await ctx.db.query('partnerInvites').withIndex('by_owner', q => q.eq('ownerId', accountId)).collect();
    const invite = invites.find(row => row.expiresAt > Date.now());
    return { accountId, partner: peer?.partnerId === accountId ? { name: peer.name } : null,
      labels, sharedLabelIds: (own?.sharedLabelIds ?? []).filter(id => labels.some(label => label.id === id)),
      invite: invite ? { code: invite.code, expiresAt: invite.expiresAt } : null };
  },
});

export const createInvite = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const user = await identity(ctx, accountId);
    const own = await account(ctx, accountId);
    if (own?.partnerId) throw new ConvexError('すでにパートナーと接続しています。');
    await clearInvites(ctx, accountId);
    const name = (user.name || user.nickname || 'パートナー').slice(0, 100);
    if (own) await ctx.db.patch(own._id, { name });
    else await ctx.db.insert('partnerAccounts', { userId: accountId, name, sharedLabelIds: [] });
    const code = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    if (await ctx.db.query('partnerInvites').withIndex('by_code', q => q.eq('code', code)).unique()) throw new ConvexError('再度お試しください。');
    await ctx.db.insert('partnerInvites', { ownerId: accountId, code, expiresAt });
    return { code, expiresAt };
  },
});

export const cancelInvite = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => { await identity(ctx, accountId); await clearInvites(ctx, accountId); },
});

export const previewInvite = query({
  args: { accountId: v.string(), code: v.string() },
  handler: async (ctx, { accountId, code }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || user.subject !== accountId || !(await accountActive(ctx, accountId)) || !/^[a-f0-9]{64}$/.test(code)) return null;
    const invite = await ctx.db.query('partnerInvites').withIndex('by_code', q => q.eq('code', code)).unique();
    if (!invite || invite.ownerId === accountId || invite.expiresAt <= Date.now()) return null;
    const owner = await account(ctx, invite.ownerId);
    const own = await account(ctx, accountId);
    return owner && !owner.partnerId && !own?.partnerId ? { name: owner.name, expiresAt: invite.expiresAt } : null;
  },
});

export const acceptInvite = mutation({
  args: { accountId: v.string(), code: v.string() },
  handler: async (ctx, { accountId, code }) => {
    const user = await identity(ctx, accountId);
    if (!/^[a-f0-9]{64}$/.test(code)) throw new ConvexError('招待リンクが無効です。');
    const invite = await ctx.db.query('partnerInvites').withIndex('by_code', q => q.eq('code', code)).unique();
    if (!invite || invite.expiresAt <= Date.now() || invite.ownerId === accountId) throw new ConvexError('招待は無効、期限切れ、または自分宛てです。');
    const owner = await account(ctx, invite.ownerId);
    const own = await account(ctx, accountId);
    if (!owner || owner.partnerId || own?.partnerId) throw new ConvexError('どちらかがすでにパートナーと接続しています。');
    const name = (user.name || user.nickname || 'パートナー').slice(0, 100);
    await ctx.db.patch(owner._id, { partnerId: accountId, sharedLabelIds: [] });
    if (own) await ctx.db.patch(own._id, { partnerId: invite.ownerId, sharedLabelIds: [], name });
    else await ctx.db.insert('partnerAccounts', { userId: accountId, name, partnerId: invite.ownerId, sharedLabelIds: [] });
    await clearInvites(ctx, accountId); await clearInvites(ctx, invite.ownerId);
  },
});

export const setLabelSharing = mutation({
  args: { accountId: v.string(), labelId: v.string(), shared: v.boolean() },
  handler: async (ctx, { accountId, labelId, shared }) => {
    await identity(ctx, accountId);
    const own = await account(ctx, accountId);
    const peer = own?.partnerId ? await account(ctx, own.partnerId) : null;
    if (!own || peer?.partnerId !== accountId) throw new ConvexError('パートナーと接続してください。');
    if (shared && !partnerLabels(await source(ctx, accountId)).some(label => label.id === labelId)) throw new ConvexError('このラベルは公開できません。');
    const labels = new Set(own.sharedLabelIds);
    if (shared) labels.add(labelId); else labels.delete(labelId);
    await ctx.db.patch(own._id, { sharedLabelIds: [...labels] });
  },
});

export const list = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || user.subject !== accountId || !(await accountActive(ctx, accountId))) return null;
    const own = await account(ctx, accountId);
    const peer = own?.partnerId ? await account(ctx, own.partnerId) : null;
    if (!peer || peer.partnerId !== accountId) return null;
    return { accountId, name: peer.name, items: publicPartnerItems(await source(ctx, peer.userId), peer.sharedLabelIds) };
  },
});

export const disconnect = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    await identity(ctx, accountId);
    const own = await account(ctx, accountId);
    if (!own) return;
    const peer = own.partnerId ? await account(ctx, own.partnerId) : null;
    await ctx.db.patch(own._id, { partnerId: undefined, sharedLabelIds: [] });
    if (peer?.partnerId === accountId) await ctx.db.patch(peer._id, { partnerId: undefined, sharedLabelIds: [] });
    await clearInvites(ctx, accountId);
  },
});
