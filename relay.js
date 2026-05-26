const {
  CHANNELS,
  LANG_BY_CHANNEL_ID,
  SOURCE_LANG_FLAG,
  MAX_MESSAGE_LENGTH,
} = require('./config');
const {
  sanitizeDiscordText,
  isTranslatable,
  detectScript,
  renderMentions,
  preprocessForTranslation,
  postprocessTranslation,
} = require('./text');
const { translateText } = require('./translator');
const { getWebhook } = require('./webhook');
const {
  recordRelay,
  getRelays,
  removeRelays,
} = require('./store');
const stats = require('./stats');
const corpusLog = require('./corpus_log');

const MAX_INFLIGHT_PER_USER = 5;
const userInFlight = new Map();

const LONG_NOTICE = {
  kr: '메시지가 너무 길어 번역되지 않았습니다',
  en: 'Message too long to translate',
  jp: 'メッセージが長すぎて翻訳されません',
  cn: '消息过长,未翻译',
};

function getDisplayInfo(message) {
  const displayName =
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username;

  const avatarURL =
    message.member?.displayAvatarURL?.({
      extension: 'png',
      size: 128,
    }) ||
    message.author.displayAvatarURL({
      extension: 'png',
      size: 128,
    });

  return { displayName, avatarURL };
}

function buildJumpLink(message) {
  if (!message.guildId) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function getAttachmentUrls(message) {
  if (!message.attachments?.size) return [];
  return Array.from(message.attachments.values()).map(
    (a) => a.url
  );
}

async function buildTranslatedBody({
  message,
  rendered,
  sourceLang,
  targetLang,
  isLong,
  hasContent,
}) {
  if (!hasContent) return '';

  if (isLong) {
    return `${sanitizeDiscordText(rendered)}\n-# ${LONG_NOTICE[targetLang]}`;
  }

  if (!isTranslatable(rendered)) {
    return sanitizeDiscordText(rendered);
  }

  if (detectScript(rendered) === targetLang) {
    return sanitizeDiscordText(rendered);
  }

  const { processed, tokens } = preprocessForTranslation(
    message.content,
    message
  );
  const translated = await translateText(
    processed,
    sourceLang,
    targetLang
  );
  return postprocessTranslation(translated, tokens);
}

function composeFinalContent({
  translated,
  message,
  targetChannelId,
  jumpLink,
  hasContent,
}) {
  let out = translated;

  if (message.reference?.messageId) {
    const refRelays = getRelays(
      message.reference.channelId || message.channelId,
      message.reference.messageId
    );
    const match = refRelays.find(
      (r) => r.targetChannelId === targetChannelId
    );
    if (match?.snippet) {
      out = out
        ? `> ${match.snippet}\n${out}`
        : `> ${match.snippet}`;
    }
  }

  if (hasContent && jumpLink) {
    out = out
      ? `${out} [[⤴]](${jumpLink})`
      : `[[⤴]](${jumpLink})`;
  }

  return out;
}

async function sendRelay({
  webhook,
  webhookName,
  avatarURL,
  content,
  attachmentUrls,
}) {
  const sendOptions = {
    content,
    username: webhookName,
    avatarURL,
    allowedMentions: {
      parse: [],
    },
  };

  if (attachmentUrls.length > 0) {
    sendOptions.files = attachmentUrls;
  }

  return webhook.send(sendOptions);
}

async function relayToTarget({
  message,
  rendered,
  sourceLang,
  targetLang,
  targetChannelId,
  displayName,
  avatarURL,
  isLong,
  hasContent,
  attachmentUrls,
  jumpLink,
}) {
  const translated = await buildTranslatedBody({
    message,
    rendered,
    sourceLang,
    targetLang,
    isLong,
    hasContent,
  });

  const finalContent = composeFinalContent({
    translated,
    message,
    targetChannelId,
    jumpLink,
    hasContent,
  });

  const targetChannel = await message.client.channels.fetch(
    targetChannelId
  );
  const webhook = await getWebhook(targetChannel);

  const sourceFlag = SOURCE_LANG_FLAG[sourceLang] || '🌐';
  const webhookName =
    `[${sourceFlag}] ${displayName}`.slice(0, 80);

  const sent = await sendRelay({
    webhook,
    webhookName,
    avatarURL,
    content: finalContent,
    attachmentUrls,
  });

  const snippet =
    (translated.split('\n')[0] || '').slice(0, 60) ||
    (attachmentUrls.length > 0 ? '(attachment)' : '');

  recordRelay({
    sourceChannelId: message.channelId,
    sourceMessageId: message.id,
    targetChannelId,
    webhookMessageId: sent.id,
    snippet,
  });

  console.log(
    `Translated ${sourceLang} -> ${targetLang}: ${translated || '(attachment only)'}`
  );

  return translated;
}

async function handleMessage(message) {
  try {
    if (message.author?.bot) return;
    if (message.webhookId) return;

    const hasContent = !!message.content?.trim();
    const hasAttachments = (message.attachments?.size || 0) > 0;
    if (!hasContent && !hasAttachments) return;

    const sourceLang = LANG_BY_CHANNEL_ID[message.channel.id];
    if (!sourceLang) return;

    const userId = message.author.id;
    const inflight = userInFlight.get(userId) || 0;
    if (inflight >= MAX_INFLIGHT_PER_USER) {
      stats.increment('rateLimitDrops');
      console.log(
        `Rate limited user ${userId}: ${inflight} in flight`
      );
      return;
    }
    userInFlight.set(userId, inflight + 1);

    try {
      const rendered = hasContent
        ? renderMentions(message.content, message)
        : '';
      const isLong =
        hasContent && rendered.length > MAX_MESSAGE_LENGTH;
      const { displayName, avatarURL } = getDisplayInfo(message);
      const attachmentUrls = getAttachmentUrls(message);
      const jumpLink = buildJumpLink(message);

      console.log(
        `[${sourceLang}] ${displayName}: ${rendered || '(attachment)'}`
      );

      const translations = {};
      await Promise.all(
        Object.entries(CHANNELS)
          .filter(([targetLang]) => targetLang !== sourceLang)
          .map(([targetLang, targetChannelId]) =>
            relayToTarget({
              message,
              rendered,
              sourceLang,
              targetLang,
              targetChannelId,
              displayName,
              avatarURL,
              isLong,
              hasContent,
              attachmentUrls,
              jumpLink,
            })
              .then((translated) => {
                if (translated) translations[targetLang] = translated;
              })
              .catch((err) => {
                stats.increment('errors');
                console.error(
                  `Failed ${sourceLang} -> ${targetLang} channel=${targetChannelId}`,
                  err?.message || err
                );
              })
          )
      );

      // Persist the full parallel translation set for offline analysis.
      // No-op if there was no textual content (attachment-only messages).
      if (hasContent && Object.keys(translations).length > 0) {
        corpusLog.record({
          sourceChannelId: message.channelId,
          sourceLang,
          sourceText: message.content,
          translations,
        });
      }
    } finally {
      const remaining = (userInFlight.get(userId) || 1) - 1;
      if (remaining <= 0) userInFlight.delete(userId);
      else userInFlight.set(userId, remaining);
    }
  } catch (err) {
    stats.increment('errors');
    console.error('messageCreate fatal error', err);
  }
}

async function handleMessageUpdate(oldMessage, newMessage) {
  try {
    if (newMessage.partial) {
      try {
        newMessage = await newMessage.fetch();
      } catch {
        return;
      }
    }

    if (newMessage.author?.bot) return;
    if (newMessage.webhookId) return;
    if (
      oldMessage &&
      !oldMessage.partial &&
      oldMessage.content === newMessage.content
    )
      return;
    if (!newMessage.content?.trim()) return;

    const sourceLang = LANG_BY_CHANNEL_ID[newMessage.channelId];
    if (!sourceLang) return;

    const relays = getRelays(newMessage.channelId, newMessage.id);
    if (relays.length === 0) return;

    const rendered = renderMentions(newMessage.content, newMessage);
    const isLong = rendered.length > MAX_MESSAGE_LENGTH;
    const jumpLink = buildJumpLink(newMessage);

    await Promise.all(
      relays.map(async ({ targetChannelId, webhookMessageId }) => {
        try {
          const targetLang = LANG_BY_CHANNEL_ID[targetChannelId];
          if (!targetLang) return;

          const translated = await buildTranslatedBody({
            message: newMessage,
            rendered,
            sourceLang,
            targetLang,
            isLong,
            hasContent: true,
          });

          const finalContent = composeFinalContent({
            translated,
            message: newMessage,
            targetChannelId,
            jumpLink,
            hasContent: true,
          });

          const targetChannel = await newMessage.client.channels.fetch(
            targetChannelId
          );
          const webhook = await getWebhook(targetChannel);

          await webhook.editMessage(webhookMessageId, {
            content: finalContent,
            allowedMentions: { parse: [] },
          });

          stats.increment('editsSync');
          console.log(
            `Edited ${sourceLang} -> ${targetLang}: ${translated}`
          );
        } catch (err) {
          stats.increment('errors');
          console.error(
            `Edit sync failed channel=${targetChannelId}`,
            err?.message || err
          );
        }
      })
    );
  } catch (err) {
    stats.increment('errors');
    console.error('messageUpdate fatal error', err);
  }
}

async function handleMessageDelete(message) {
  try {
    const relays = getRelays(message.channelId, message.id);
    if (relays.length === 0) return;

    await Promise.all(
      relays.map(async ({ targetChannelId, webhookMessageId }) => {
        try {
          const targetChannel = await message.client.channels.fetch(
            targetChannelId
          );
          const webhook = await getWebhook(targetChannel);
          await webhook.deleteMessage(webhookMessageId);
          stats.increment('deletesSync');
          console.log(
            `Deleted relay channel=${targetChannelId} msg=${webhookMessageId}`
          );
        } catch (err) {
          stats.increment('errors');
          console.error(
            `Delete sync failed channel=${targetChannelId}`,
            err?.message || err
          );
        }
      })
    );

    removeRelays(message.channelId, message.id);
  } catch (err) {
    stats.increment('errors');
    console.error('messageDelete fatal error', err);
  }
}

module.exports = {
  handleMessage,
  handleMessageUpdate,
  handleMessageDelete,
};
