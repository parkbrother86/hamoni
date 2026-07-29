// Optional public "warning count" role tags shown next to an offender's name.
//
// Driven by config.MODERATION.warnRoleTiers. No-op when that list is empty, so
// the feature stays off until an admin fills in role ids. Requires the bot to
// have Manage Roles and a role above the tier roles.

const { MODERATION } = require('./config');

// Highest tier whose `atLeast` <= count. Returns null if none apply.
function tierForCount(count) {
  const tiers = MODERATION.warnRoleTiers || [];
  let picked = null;
  for (const t of tiers) {
    if (t.roleId && count >= t.atLeast) {
      if (!picked || t.atLeast > picked.atLeast) picked = t;
    }
  }
  return picked;
}

function allTierRoleIds() {
  return (MODERATION.warnRoleTiers || []).map((t) => t.roleId).filter(Boolean);
}

// Sync a member's warn-count role to their current strike count. Adds the
// matching tier role and removes any other warn-tier roles. Best-effort:
// permission/hierarchy failures are logged, not thrown.
async function syncWarnRole(member, count) {
  const roleIds = allTierRoleIds();
  if (roleIds.length === 0 || !member) return;

  const target = tierForCount(count);
  const targetId = target?.roleId || null;

  try {
    for (const roleId of roleIds) {
      const has = member.roles.cache.has(roleId);
      if (roleId === targetId && !has) {
        await member.roles.add(roleId, 'warn-count tier sync');
      } else if (roleId !== targetId && has) {
        await member.roles.remove(roleId, 'warn-count tier sync');
      }
    }
  } catch (err) {
    console.error('roles: warn-role sync failed —', err?.message || err);
  }
}

module.exports = {
  syncWarnRole,
};
