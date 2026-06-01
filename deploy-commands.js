require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, TextInputStyle } = require('discord.js');
const fs   = require('fs-extra');
const path = require('path');

const TOKEN     = process.env.TOKEN?.trim();
const CLIENT_ID = process.env.CLIENT_ID?.trim();
const configPath = path.resolve(__dirname, 'config.json');

if (!TOKEN || !CLIENT_ID) {
  console.error('ARCUS: TOKEN and CLIENT_ID are required to deploy commands.');
  process.exit(1);
}
if (CLIENT_ID === 'your_actual_client_id_here') {
  console.error('ARCUS Critical: You are still using the placeholder CLIENT_ID in your .env file.');
  process.exit(1);
}

// ─── Exact mirror of buildCommandData() in index.js ──────────────────────────
function buildCommands() {
  return new SlashCommandBuilder()
    .setName('op')
    .setDescription('ARCUS operation commands')
    .addSubcommand(s => s.setName('create').setDescription('Create a new operation'))
    .addSubcommand(s => s.setName('end').setDescription('End an operation')
      .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommand(s => s.setName('delete').setDescription('Admin: Delete an operation')
      .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommandGroup(g => g.setName('admin').setDescription('Manage Admin roles')
      .addSubcommand(s => s.setName('grant').setDescription('Grant admin to a role').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
      .addSubcommand(s => s.setName('revoke').setDescription('Revoke admin from a role').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))))
    .addSubcommandGroup(g => g.setName('creator').setDescription('Manage Creator roles')
      .addSubcommand(s => s.setName('grant').setDescription('Grant creator to a role').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
      .addSubcommand(s => s.setName('revoke').setDescription('Revoke creator from a role').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))))
    .addSubcommandGroup(g => g.setName('tactical').setDescription('Manage Tactical roles')
      .addSubcommand(s => s.setName('add').setDescription('Add a tactical role').addStringOption(o => o.setName('name').setDescription('Role name').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a tactical role').addStringOption(o => o.setName('name').setDescription('Role name').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List tactical roles')))
    .addSubcommandGroup(g => g.setName('template').setDescription('Manage Mission templates')
      .addSubcommand(s => s.setName('add').setDescription('Admin: Create a template'))
      .addSubcommand(s => s.setName('suggest').setDescription('Suggest a template for approval'))
      .addSubcommand(s => s.setName('remove').setDescription('Delete a template').addIntegerOption(o => o.setName('index').setDescription('Template index').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List all templates')))
    .addSubcommandGroup(g => g.setName('commendation').setDescription('Manage the Commendation Registry')
      .addSubcommand(s => s.setName('add').setDescription('Add a commendation to the registry'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a commendation')
        .addStringOption(o => o.setName('name').setDescription('Medal name').setRequired(true).setAutocomplete(true)))
      .addSubcommand(s => s.setName('list').setDescription('List commendations')))
    .addSubcommandGroup(g => g.setName('bct').setDescription('Basic Combat Training')
      .addSubcommand(s => s.setName('request').setDescription('Request BCT training')))
    .addSubcommandGroup(g => g.setName('manage').setDescription('Operation management tools')
      .addSubcommand(s => s.setName('list').setDescription('List active operations'))
      .addSubcommand(s => s.setName('remind').setDescription('Send a manual operation reminder')
        .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Optional reminder message').setRequired(false)))
      .addSubcommand(s => s.setName('transfer').setDescription('Transfer operation ownership')
        .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true))
        .addUserOption(o => o.setName('target').setDescription('New operation creator').setRequired(true)))
      .addSubcommand(s => s.setName('activity').setDescription('Combined activity and inactivity report'))
      .addSubcommand(s => s.setName('approval_channel').setDescription('Set the operation approval channel')
        .addChannelOption(o => o.setName('channel').setDescription('Approval channel').setRequired(true)))
      .addSubcommand(s => s.setName('approval_toggle').setDescription('Enable or disable operation approval')
        .addBooleanOption(o => o.setName('enabled').setDescription('Require approval before posting ops').setRequired(true))))
    .addSubcommandGroup(g => g.setName('status').setDescription('Availability status')
      .addSubcommand(s => s.setName('set').setDescription('Set your availability')
        .addStringOption(o => o.setName('state').setDescription('Availability').setRequired(true)
          .addChoices(
            { name: 'Available',   value: 'available' },
            { name: 'Limited',     value: 'limited' },
            { name: 'Unavailable', value: 'unavailable' }
          ))
        .addStringOption(o => o.setName('note').setDescription('Optional note').setRequired(false)))
      .addSubcommand(s => s.setName('view').setDescription('View availability')
        .addUserOption(o => o.setName('target').setDescription('User to view').setRequired(false))))
    .addSubcommand(s => s.setName('set_channel').setDescription('Set the default ops channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('set_logs_channel').setDescription('Set the logs channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('set_announcement_channel').setDescription('Set the announcements channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('set_bct_channel').setDescription('Set the BCT request channel')
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
    .addSubcommand(s => s.setName('set_bct_role').setDescription('Set the BCT instructor role')
      .addRoleOption(o => o.setName('role').setDescription('Instructor role').setRequired(true)))
    .addSubcommand(s => s.setName('log').setDescription('Send a manual log entry')
      .addStringOption(o => o.setName('message').setDescription('Log content').setRequired(true)))
    .addSubcommand(s => s.setName('stats').setDescription('View operator statistics')
      .addUserOption(o => o.setName('target').setDescription('User to view')))
    .addSubcommand(s => s.setName('settings').setDescription('Configure ARCUS settings'))
    // /op aar — only takes an ID; report text is collected via modal in the bot
    .addSubcommand(s => s.setName('aar').setDescription('File an After Action Report')
      .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommand(s => s.setName('profile').setDescription('View an operator service record')
      .addUserOption(o => o.setName('target').setDescription('User to view')))
    .addSubcommand(s => s.setName('award').setDescription('Admin: Award a medal')
      .addUserOption(o => o.setName('target').setDescription('Operator').setRequired(true))
      .addStringOption(o => o.setName('medal').setDescription('Medal name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('revoke').setDescription('Admin: Revoke a medal')
      .addUserOption(o => o.setName('target').setDescription('Operator').setRequired(true))
      .addStringOption(o => o.setName('medal').setDescription('Medal name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('leaderboard').setDescription('View top operators'))
    .addSubcommand(s => s.setName('motm').setDescription('Show member of the month'))
    .addSubcommand(s => s.setName('clear_stats').setDescription('Admin: Wipe all attendance statistics'))
    .toJSON();
}

// ─── Guild ID resolution ──────────────────────────────────────────────────────
function getGuildIds() {
  if (process.env.GUILD_ID) {
    return process.env.GUILD_ID.split(',').map(id => id.trim()).filter(Boolean);
  }
  if (!fs.existsSync(configPath)) return [];
  const cfg = fs.readJsonSync(configPath);
  return Object.keys(cfg.guilds || {});
}

// ─── Deploy ───────────────────────────────────────────────────────────────────
async function main() {
  const command  = buildCommands();
  const guildIds = getGuildIds();

  if (!guildIds.length) {
    console.error('ARCUS: No guild IDs found. Set GUILD_ID in .env or add guilds to config.json.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  // Clear any stale global commands
  console.log('ARCUS: Clearing global commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log('ARCUS: Global commands cleared.');

  // Deploy to each guild
  for (const guildId of guildIds) {
    try {
      console.log(`ARCUS: Deploying to guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [command] });

      const deployed = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, guildId));
      const op       = deployed.find(c => c.name === 'op');
      const subs     = op?.options?.map(o => `${o.name}(${(o.options || []).map(s => s.name).join(',')})`).join(' | ') || 'none';
      console.log(`ARCUS: ✅ Guild ${guildId} — /op subcommands: ${subs}`);
    } catch (err) {
      console.error(`ARCUS: ❌ Failed for guild ${guildId}:`, err.message);
    }
  }

  console.log('ARCUS: Deploy complete.');
}

main().catch(err => {
  console.error('ARCUS: Deploy failed:', err);
  process.exit(1);
});