require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { buildCommandData } = require('./commands');
const fs   = require('fs-extra');
const path = require('path');

const TOKEN     = process.env.TOKEN?.trim();
const CLIENT_ID = process.env.CLIENT_ID?.trim();
const configPath = path.resolve(__dirname, 'config.json');

if (!TOKEN || !CLIENT_ID) {
  console.error('ARCUS: TOKEN and CLIENT_ID are required.');
  process.exit(1);
}

function isValidSnowflake(id) {
  return /^\d{17,19}$/.test(id);
}

function getGuildIds() {
  if (process.env.GUILD_ID) {
    return process.env.GUILD_ID.split(',').map(id => id.trim()).filter(Boolean);
  }
  if (!fs.existsSync(configPath)) return [];
  try {
    const cfg = fs.readJsonSync(configPath);
    return Object.keys(cfg.guilds || {});
  } catch (err) {
    console.warn('ARCUS: Could not read config.json:', err.message);
    return [];
  }
}

async function main() {
  const command  = buildCommandData().toJSON();
  const guildIds = getGuildIds();

  if (!guildIds.length) {
    console.error('ARCUS: No guild IDs found.');
    process.exit(1);
  }

  const invalidIds = guildIds.filter(id => !isValidSnowflake(id));
  if (invalidIds.length) {
    console.error(`ARCUS: Invalid guild IDs: ${invalidIds.join(', ')}`);
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  console.log('ARCUS: Clearing global commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

  for (const guildId of guildIds) {
    try {
      console.log(`ARCUS: Deploying to guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [command] });
      console.log(`ARCUS: ✅ Guild ${guildId} done.`);
    } catch (err) {
      console.error(`ARCUS: ❌ Failed for guild ${guildId}:`, err.message);
    }
  }
  console.log('ARCUS: Deploy complete.');
}

main().catch(err => { console.error('ARCUS: Deploy failed:', err); process.exit(1); });
