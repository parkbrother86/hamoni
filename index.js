require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const { CHANNELS } = require('./config');
const {
  handleMessage,
  handleMessageUpdate,
  handleMessageDelete,
} = require('./relay');
const {
  registerCommands,
  handleInteraction,
} = require('./commands');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const [lang, id] of Object.entries(CHANNELS)) {
    try {
      const ch = await client.channels.fetch(id);
      console.log(`${lang}: #${ch.name} ${ch.id}`);
    } catch (err) {
      console.error(`${lang}: fetch failed ${id}`, err?.message || err);
    }
  }

  try {
    await registerCommands(client);
  } catch (err) {
    console.error('registerCommands failed', err?.message || err);
  }
});

client.on('messageCreate', handleMessage);
client.on('messageUpdate', handleMessageUpdate);
client.on('messageDelete', handleMessageDelete);
client.on('interactionCreate', handleInteraction);

client.login(process.env.DISCORD_TOKEN);
