const webhookCache = new Map();

async function getWebhook(channel) {
  const existing = webhookCache.get(channel.id);
  if (existing) return existing;

  const promise = (async () => {
    const hooks = await channel.fetchWebhooks();

    let webhook = hooks.find(
      (h) => h.owner?.id === channel.client.user.id
    );

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Hamoni Relay',
      });
    }

    return webhook;
  })();

  webhookCache.set(channel.id, promise);
  promise.catch(() => webhookCache.delete(channel.id));

  return promise;
}

module.exports = {
  getWebhook,
};
