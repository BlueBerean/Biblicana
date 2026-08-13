/**
 * Channel allowlist semantics, shared by AI chat and passive detection.
 *
 * Lives in its own module because both features need the identical rule and
 * neither owns it: importing an "isAiChannelAllowed" into the passive path (or
 * vice versa) would read as a dependency that isn't really there.
 */

/**
 * Is this feature allowed to act in this channel, given the guild's allowlist?
 *
 * EMPTY allowlist → allowed everywhere. This is the default and the
 * backward-compatible answer for every guild configured before a given feature
 * gained a picker, so adding one can never silently switch a guild off.
 *
 * Otherwise the channel's own id must be listed, OR its parent's — so threads
 * inherit their parent channel's allowance and an admin doesn't have to list
 * every thread, including ones that don't exist yet.
 *
 * A channel we can't identify at all is NOT allowed, but only once an allowlist
 * exists. With no allowlist the first line has already returned true, so an
 * unreadable channel object can never cost a guild the feature it never
 * restricted.
 */
export function isChannelAllowed(allowedChannelIds, channel) {
    if (!allowedChannelIds || allowedChannelIds.length === 0) return true;
    if (!channel) return false;
    if (allowedChannelIds.includes(channel.id)) return true;
    if (channel.parentId && allowedChannelIds.includes(channel.parentId)) return true;
    return false;
}
