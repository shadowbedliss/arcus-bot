require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

const TOKEN = process.env.TOKEN?.trim();
const CLIENT_ID = process.env.CLIENT_ID?.trim();
const configPath = path.resolve(__dirname, 'config.json');

if (!TOKEN || !CLIENT_ID) {
  console.error('ARCUS: TOKEN and CLIENT_ID are required to deploy commands.');
  process.exit(1);
}

function buildCommands() {
  const opCommand = new SlashCommandBuilder()
    .setName('op')
    .setDescription('ARCUS operation commands')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Start the operation creation process in DMs'))
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End an operation')
        .addStringOption(opt => opt.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Admin: Delete an operation and clean up messages')
        .addStringOption(opt => opt.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommandGroup(group =>
      group.setName('admin')
        .setDescription('Manage Admin roles')
        .addSubcommand(sub => sub.setName('grant').setDescription('Add a role to Admin list').addRoleOption(o => o.setName('role').setDescription('The role to grant admin privileges').setRequired(true)))
        .addSubcommand(sub => sub.setName('revoke').setDescription('Remove a role from Admin list').addRoleOption(o => o.setName('role').setDescription('The role to revoke admin privileges').setRequired(true))))
    .addSubcommandGroup(group =>
      group.setName('creator')
        .setDescription('Manage Creator roles')
        .addSubcommand(sub => sub.setName('grant').setDescription('Add a role to Creator list').addRoleOption(o => o.setName('role').setDescription('The role to allow operation creation').setRequired(true)))
        .addSubcommand(sub => sub.setName('revoke').setDescription('Remove a role from Creator list').addRoleOption(o => o.setName('role').setDescription('The role to disallow operation creation').setRequired(true))))
    .addSubcommandGroup(group =>
      group.setName('tactical')
        .setDescription('Manage Tactical roles')
        .addSubcommand(sub => sub.setName('add').setDescription('Add a role to selection list').addStringOption(o => o.setName('name').setDescription('The tactical role name').setRequired(true)))
        .addSubcommand(sub => sub.setName('remove').setDescription('Remove a role from selection list').addStringOption(o => o.setName('name').setDescription('The tactical role name').setRequired(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List all selectable tactical roles')))
    .addSubcommandGroup(group =>
      group.setName('template')
        .setDescription('Manage Mission templates')
        .addSubcommand(sub => sub.setName('add').setDescription('Create a new mission template'))
        .addSubcommand(sub => sub.setName('remove').setDescription('Delete a template by index').addIntegerOption(o => o.setName('index').setDescription('The template index').setRequired(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List all saved templates')))
    .addSubcommand(sub =>
      sub.setName('set_channel')
        .setDescription('Set the default channel for operations')
        .addChannelOption(opt => opt.setName('channel').setDescription('The channel to post operations in').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('View your operation participation statistics')
        .addUserOption(opt => opt.setName('target').setDescription('The user to view stats for').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('Configure ARCUS settings for this server'))
    .addSubcommand(sub =>
      sub.setName('aar')
        .setDescription('Add an After Action Report to an operation')
        .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true))
        .addStringOption(o => o.setName('report').setDescription('The mission summary').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('clear_stats')
        .setDescription('Admin: Permanently wipe all attendance statistics'));

  const profileCommand = new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View an ARCUS operational service record')
    .addUserOption(opt => opt.setName('target').setDescription('The user to view').setRequired(false));

  const leaderboardCommand = new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the top ARCUS operators');

  return [opCommand.toJSON(), profileCommand.toJSON(), leaderboardCommand.toJSON()];
}

function getGuildIds() {
  if (process.env.GUILD_ID) {
    return process.env.GUILD_ID.split(',').map(id => id.trim()).filter(Boolean);
  }
  if (!fs.existsSync(configPath)) return [];
  const config = fs.readJsonSync(configPath);
  return Object.keys(config.guilds || {});
}

async function main() {
  const commands = buildCommands();
  const guildIds = getGuildIds();
  const commandNames = commands.map(command => `/${command.name}`).join(', ');
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  const globalBefore = await rest.get(Routes.applicationCommands(CLIENT_ID));
  console.log(`ARCUS: Global commands before cleanup: ${globalBefore.map(command => `/${command.name}`).join(', ') || 'none'}`);

  console.log('ARCUS: Clearing global commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

  if (guildIds.length === 0) {
    console.error('ARCUS: No guild IDs found. Set GUILD_ID or add guilds to config.json.');
    process.exit(1);
  }

  for (const guildId of guildIds) {
    const guildBefore = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, guildId));
    console.log(`ARCUS: Guild ${guildId} commands before cleanup: ${guildBefore.map(command => `/${command.name}`).join(', ') || 'none'}`);

    console.log(`ARCUS: Clearing guild commands for ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] });

    console.log(`ARCUS: Deploying commands to ${guildId}: ${commandNames}`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });

    const guildAfter = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, guildId));
    console.log(`ARCUS: Guild ${guildId} commands after deploy: ${guildAfter.map(command => `/${command.name}`).join(', ') || 'none'}`);
  }

  const globalAfter = await rest.get(Routes.applicationCommands(CLIENT_ID));
  console.log(`ARCUS: Global commands after cleanup: ${globalAfter.map(command => `/${command.name}`).join(', ') || 'none'}`);

  console.log('ARCUS: Command deploy complete.');
}

main().catch(error => {
  console.error('ARCUS: Command deploy failed:', error);
  process.exit(1);
});
