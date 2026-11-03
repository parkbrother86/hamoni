const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const discord = require('discord.js');

// Local dependencies are explicit mocks: tests cannot open the bot's stores,
// connect to Discord, or construct a translation-provider client.
function load(file, mocks = {}, env = {}) {
  const filename = path.join(__dirname, '..', file);
  const mod = { exports: {} };
  const requireMock = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'discord.js') return discord;
    throw new Error(`Unexpected test dependency: ${name}`);
  };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['require', 'module', 'exports', 'process', 'console'], { filename }
  )(requireMock, mod, mod.exports, { env }, console);
  return mod.exports;
}

const channelEnv = {
  DISCORD_CHANNEL_KR_ID: 'fixture-kr',
  DISCORD_CHANNEL_EN_ID: 'fixture-en',
  DISCORD_CHANNEL_JP_ID: 'fixture-jp',
  DISCORD_CHANNEL_CN_ID: 'fixture-cn',
};

test('channel configuration has no deployment defaults and requires distinct channels', () => {
  const missing = load('config.js');
  assert.deepEqual(missing.LANG_BY_CHANNEL_ID, {});
  assert.equal(missing.MODERATION.modLogChannelId, '');
  assert.throws(() => missing.validateChannels(), /DISCORD_CHANNEL_KR_ID/);
  const configured = load('config.js', {}, {
    ...channelEnv, DISCORD_CHANNEL_KR_ID: ' fixture-kr ', MODLOG_CHANNEL_ID: ' mod ',
  });
  configured.validateChannels();
  assert.equal(configured.LANG_BY_CHANNEL_ID['fixture-kr'], 'kr');
  assert.equal(configured.MODERATION.modLogChannelId, 'mod');
  assert.equal(configured.MODERATION.cooldown.enabled, false);
  const duplicate = load('config.js', {}, {
    ...channelEnv, DISCORD_CHANNEL_EN_ID: channelEnv.DISCORD_CHANNEL_KR_ID,
  });
  assert.throws(() => duplicate.validateChannels(), /distinct/);
});

test('startup rejects missing channels before constructing external clients', () => {
  assert.throws(() => load('index.js', {
    dotenv: { config() {} },
    './config': load('config.js'),
    'discord.js': { Client() { assert.fail('client must not be created'); } },
  }), /Set required channel IDs/);
});

test('prescreen buttons and modals reach the permission-gated action handlers', async () => {
  const seen = [];
  const commands = load('commands.js', {
    './stats': {}, './metrics': {}, './report': {},
    './modactions': {
      handleEnforceButton: async (i) => seen.push(`button:${i.customId}`),
      handleEnforceModal: async (i) => seen.push(`modal:${i.customId}`),
    },
  });
  for (const [kind, customId] of [
    ['button', 'ps|judge|user|channel|message'],
    ['modal', 'psm|warn|user|channel|message'],
    ['button', 'rv|warn|user|channel|message'],
    ['button', 'rl|ignore|user'],
  ]) {
    await commands.handleInteraction({
      customId,
      isMessageContextMenuCommand: () => false,
      isModalSubmit: () => kind === 'modal',
      isButton: () => kind === 'button',
    });
  }
  assert.deepEqual(seen, [
    'button:ps|judge|user|channel|message', 'modal:psm|warn|user|channel|message',
    'button:rv|warn|user|channel|message', 'button:rl|ignore|user',
  ]);
});

function logHarness(channelId = 'private-mod-channel') {
  const sent = [];
  const client = { channels: { fetch: async (id) => {
    assert.equal(id, channelId);
    return { send: async (payload) => sent.push({
      embeds: payload.embeds.map((x) => x.toJSON()),
      components: payload.components.map((x) => x.toJSON()),
      allowedMentions: payload.allowedMentions,
    }) };
  } } };
  const log = load('modlog.js', { './config': { MODERATION: { modLogChannelId: channelId } } });
  return { sent, client, log };
}

test('prescreen cards carry the source reference and valid Discord controls without mentions', async () => {
  const h = logHarness();
  await h.log.postPrescreenFlag(h.client, {
    authorTag: 'fixture-user', authorId: 'user', channelName: 'fixture-chat',
    ruleId: 'spam', content: 'fixture message', guildId: 'guild',
    channelId: 'channel', messageId: 'message',
  });
  const payload = h.sent[0];
  assert.ok(payload.embeds[0].fields.some((f) =>
    f.value === 'https://discord.com/channels/guild/channel/message'));
  const ids = payload.components.flatMap((row) => row.components.map((b) => b.custom_id));
  assert.ok(ids.includes('ps|judge|user|channel|message'));
  assert.ok(ids.includes('ps|warn|user|channel|message'));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('prescreen card without a source reference has no judgment button', async () => {
  const h = logHarness();
  await h.log.postPrescreenFlag(h.client, { authorId: 'user', content: 'fixture' });
  assert.ok(h.sent[0].components.flatMap((r) => r.components)
    .every((b) => !b.custom_id.startsWith('ps|judge|')));
  const disabled = logHarness('');
  await disabled.log.postPrescreenFlag(disabled.client, { content: 'fixture' });
  assert.equal(disabled.sent.length, 0);
});

function actionHarness({ allowed = true, missing = false, verdict = { violation: true, ruleId: 'spam', confidence: 'high' } } = {}) {
  const events = { replies: [], edits: [], cards: [], ignored: [], verdicts: [], judged: [] };
  const message = { id: 'message', content: 'fixture message',
    channel: { id: 'channel', name: 'fixture-chat' },
    author: { id: 'user', tag: 'fixture-user', username: 'fixture-user' } };
  const actions = load('modactions.js', {
    './strikes': {}, './roles': {}, './rules': {},
    './enforce': {
      applyStrike() { assert.fail('judgment must not impose a strike'); },
      applyTimeout() { assert.fail('judgment must not impose a timeout'); },
    },
    './reportload': { ignore: (id) => events.ignored.push(id) },
    './moderation': {
      gatherContext: async (ch, msg) => {
        assert.equal(ch, message.channel); assert.equal(msg, message);
        return { text: 'before / target / after' };
      },
      judge: async (input) => { events.judged.push(input); return verdict; },
    },
    './modlog': { postVerdict: async (client, data) => events.verdicts.push(data) },
  });
  const interaction = {
    customId: 'ps|judge|user|channel|message',
    memberPermissions: { has: (permission) => {
      assert.equal(permission, discord.PermissionFlagsBits.ModerateMembers);
      return allowed;
    } },
    user: { tag: 'fixture-moderator' },
    message: { id: 'card', embeds: [], edit: async (p) => events.cards.push(p) },
    client: { channels: { fetch: async (id) => {
      assert.equal(id, 'channel');
      return { messages: { fetch: async (id) => {
        assert.equal(id, 'message');
        if (missing) throw new Error('fixture message removed');
        return message;
      } } };
    } } },
    reply: async (p) => events.replies.push(p),
    deferReply: async (p) => events.replies.push(p),
    editReply: async (p) => events.edits.push(p),
  };
  return { actions, interaction, events };
}

test('non-moderators cannot judge or submit an enforcement modal', async () => {
  const h = actionHarness({ allowed: false });
  await h.actions.handleEnforceButton(h.interaction);
  h.interaction.customId = 'psm|warn|user|channel|message';
  await h.actions.handleEnforceModal(h.interaction);
  assert.equal(h.events.replies.length, 2);
  assert.ok(h.events.replies.every((p) => p.flags === discord.MessageFlags.Ephemeral));
  assert.equal(h.events.judged.length + h.events.cards.length + h.events.verdicts.length, 0);
});

test('dismissing one prescreen flag does not suppress report-load alerts', async () => {
  const h = actionHarness();
  h.interaction.customId = 'ps|ignore|user';
  await h.actions.handleEnforceButton(h.interaction);
  assert.deepEqual(h.events.ignored, []);
  assert.deepEqual(h.events.cards[0].components, []);
  h.interaction.customId = 'rl|ignore|user';
  await h.actions.handleEnforceButton(h.interaction);
  assert.deepEqual(h.events.ignored, ['user']);
});

test('precise judgment uses conversation context and queues a violation without punishment', async () => {
  const h = actionHarness();
  await h.actions.handleEnforceButton(h.interaction);
  assert.equal(h.events.judged[0].context, 'before / target / after');
  assert.equal(h.events.judged[0].content, 'fixture message');
  assert.equal(h.events.verdicts[0].review, true);
  assert.equal(h.events.verdicts[0].sourceChannelId, 'channel');
  assert.equal(h.events.verdicts[0].sourceMessageId, 'message');
  assert.deepEqual(h.events.cards[0].components, []);
  assert.equal(h.events.replies[0].flags, discord.MessageFlags.Ephemeral);
});

test('cleared judgment produces no enforcement controls', async () => {
  const h = actionHarness({ verdict: { violation: false, reason: 'fixture reason' } });
  await h.actions.handleEnforceButton(h.interaction);
  assert.equal(h.events.verdicts[0].review, false);
  const log = logHarness();
  await log.log.postVerdict(log.client, h.events.verdicts[0]);
  assert.deepEqual(log.sent[0].components, []);
});

test('missing messages and failed judgment leave the card actionable', async () => {
  for (const options of [{ missing: true }, { verdict: { error: 'fixture failure' } }]) {
    const h = actionHarness(options);
    await h.actions.handleEnforceButton(h.interaction);
    assert.equal(h.events.cards.length, 0);
    assert.equal(h.events.verdicts.length, 0);
    assert.equal(h.events.edits.length, 1);
  }
});
