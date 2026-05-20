
// ARCUS: Operations Management Bot - Full Stable Rework
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  Events,
  MessageFlags,
  Routes,
  ModalBuilder,
  ActivityType,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { REST } = require('@discordjs/rest');
const fs = require('fs-extra');
const path = require('path');
 
// --- Environment Validation ---
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
  console.error('ARCUS Critical: TOKEN or CLIENT_ID is missing in environment variables.');
  process.exit(1);
}
const TOKEN = process.env.TOKEN.trim();
const CLIENT_ID = process.env.CLIENT_ID.trim();
 
// --- Stricter Token Validation ---
if (TOKEN.includes('your_bot_token_here') || TOKEN.length < 50) {
  console.error('ARCUS Critical: The TOKEN provided is either the placeholder text or is too short to be valid.');
  console.error('Please ensure you have pasted the actual Bot Token from the Discord Developer Portal.');
  process.exit(1);
}
 
// --- Configuration & Data Persistence ---
const configPath = path.resolve(__dirname, 'config.json');
const DATA_FILE = path.join(__dirname, 'data.json');
 
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeJsonSync(configPath, { guilds: {} }, { spaces: 2 });
  }
  return fs.readJsonSync(configPath);
}
 
let config = loadConfig();
 
if (!config.guilds) {
  config.guilds = {};
  fs.writeJsonSync(configPath, config, { spaces: 2 });
}
 
console.log(`ARCUS: Multi-guild config initialized from ${configPath}`);
 
function saveConfig() {
  fs.writeJsonSync(configPath, config, { spaces: 2 });
}
 
function getGuildConfig(guildId) {
  if (!guildId) return {};
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      authorizedRoles: ["Admin"],
      eventCreatorRoles: [],
      operationsChannelId: "",
      maxSquadSize: 4,
      selectableRoles: ["Point Man", "Overwatch", "Medic", "Demolitions"],
      templates: [],
      defaultRole: "Point Man"
    };
    saveConfig();
  }
  return config.guilds[guildId];
}
 
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeJsonSync(DATA_FILE, { operations: {}, users: {} }, { spaces: 2 });
  }
  return fs.readJsonSync(DATA_FILE);
}
 
function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}
 
// --- Logic Helpers ---
function isAuthorized(member, guildId) {
  if (!member || !member.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const guildConfig = getGuildConfig(guildId);
  const authRoles = guildConfig.authorizedRoles || [];
  return member.roles.cache.some(role => {
    return authRoles.some(auth =>
      auth.toLowerCase() === role.name.toLowerCase() || auth === role.id
    );
  });
}
 
function parseOpTime(timeStr) {
  if (!timeStr) return NaN;
  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const parts = timeStr.toLowerCase().trim().split(/\s+/);
  const dayIndex = parts.findIndex(p => days.includes(p));
  const timePart = parts.find(p => p.includes(':') || p.endsWith('am') || p.endsWith('pm'));
 
  if (dayIndex !== -1 && timePart) {
    const targetDay = days.indexOf(parts[dayIndex]);
    let date = new Date();
    const diff = (targetDay + 7 - now.getDay()) % 7;
    date.setDate(now.getDate() + diff);
 
    let hours = 0, minutes = 0;
    if (timePart.includes(':')) {
      const t = timePart.split(':');
      hours = parseInt(t[0]);
      minutes = parseInt(t[1]);
    } else {
      hours = parseInt(timePart);
    }
 
    if (timePart.toLowerCase().includes('pm') && hours < 12) hours += 12;
    if (timePart.toLowerCase().includes('am') && hours === 12) hours = 0;
 
    date.setHours(hours, minutes, 0, 0);
    if (date < now) date.setDate(date.getDate() + 7);
    return date.getTime();
  }
 
  return Date.parse(timeStr);
}
 
const squadNames = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Gamma', 'Hotel', 'India'];
 
// --- Rank Structure ---
const ranks = [
  { name: 'Recruit', minAttended: 0 },
  { name: 'Sergeant', minAttended: 3, requireBCT: true },
  { name: 'Lieutenant', minAttended: 6, minRecruits: 2 },
  { name: 'Captain', minAttended: 10, minLed: 3, minRecruits: 4 },
  { name: 'Council', minAttended: 0, appointed: true },
  { name: 'Council Chief', minAttended: 0, appointed: true },
  { name: 'Deputy Commander', minAttended: 0, appointed: true },
  { name: 'Commander', minAttended: 0, appointed: true }
];
 
function getRank(member, stats) {
  if (member && member.roles) {
    const roleCache = member.roles.cache;
    for (let i = ranks.length - 1; i >= 0; i--) {
      const rank = ranks[i];
      if (roleCache.some(role => role.name.toLowerCase().trim() === rank.name.toLowerCase().trim())) {
        return rank;
      }
    }
  }
  return ranks[0];
}
 
function formatSquadListing(op, guildId) {
  const lines = [];
  const guildConfig = getGuildConfig(guildId);
  for (const squad of op.squads) {
    const members = (squad.members || []).map(m => {
      const roleLabel = m.role || guildConfig.defaultRole;
      return `• ${m.username}${roleLabel ? ` (${roleLabel})` : ''}`;
    }).join('\n') || '_Empty_';
    lines.push(`**${squad.name}**\n${members}`);
  }
  return lines.join('\n\n');
}
 
function buildOperationEmbed(op) {
  const embed = new EmbedBuilder()
    .setTitle(`ARCUS: Operation ${op.name}`)
    .setDescription(`Status: ${op.locked ? 'Locked' : 'Active'}`)
    .addFields(
      { name: 'Time', value: op.time || 'N/A', inline: true },
      { name: 'Briefing', value: op.description || 'N/A' }
    );
 
  if (op.aar_phases) {
    embed.addFields({ name: '📝 AAR: Mission Summary', value: op.aar_phases });
  }
  if (op.aar_performance) {
    embed.addFields({ name: '⭐ Personnel Evaluation', value: op.aar_performance });
  }
 
  embed.addFields({ name: 'Squads', value: formatSquadListing(op, op.guildId) });
  return embed.setFooter({ text: `ID: ${op.id} | Creator: ${op.creatorTag}` });
}
 
function canCreateEvent(member, guildId) {
  if (!member || !member.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const guildConfig = getGuildConfig(guildId);
  return isAuthorized(member, guildId) || member.roles.cache.some(role => (guildConfig.eventCreatorRoles || []).includes(role.id));
}
 
function canCreateSquad(member, guildId) {
  return canCreateEvent(member, guildId);
}
 
function buildActionRow(op) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`op:join:${op.id}`).setLabel('✅ Join').setStyle(ButtonStyle.Success).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:leave:${op.id}`).setLabel('❌ Leave').setStyle(ButtonStyle.Danger).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:role:${op.id}`).setLabel('🎯 Role').setStyle(ButtonStyle.Primary).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:squad:${op.id}`).setLabel('➕ Squad').setStyle(ButtonStyle.Secondary).setDisabled(op.locked)
  );
}
 
function getOpById(data, opId) {
  if (!data || !data.operations) return null;
  return data.operations[opId] || null;
}
 
function buildSettingsEmbed(guildConfig, section = 'main') {
  const data = loadData();
  const activeOps = Object.values(data.operations).filter(op => !op.locked).length;
 
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTimestamp();
 
  if (section === 'main') {
    embed.setTitle('🛡️ ARCUS COMMAND | Master Control')
      .setDescription('**System Core Status & Configuration Deployment**\n\nUse the buttons below to navigate through system modules.')
      .addFields(
        { name: '📡 Operations Channel', value: guildConfig.operationsChannelId ? `<#${guildConfig.operationsChannelId}>` : '`Not Configured`', inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: '👥 Max Squad Size', value: `\`${guildConfig.maxSquadSize || 4}\``, inline: true },
        { name: '🎯 Default Role', value: `\`${guildConfig.defaultRole || 'Point Man'}\``, inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: '📂 Saved Templates', value: `\`${(guildConfig.templates || []).length}\``, inline: true },
        { name: '📊 System Metrics', value: `Ping: \`${client.ws.ping}ms\`\nUptime: \`${Math.floor(client.uptime / 3600000)}h ${Math.floor((client.uptime % 3600000) / 60000)}m\`\nActive Ops: \`${activeOps}\`` }
      )
      .setFooter({ text: 'ARCUS v1.0.0 • All systems operational' });
  } else if (section === 'gen') {
    embed.setTitle('⚙️ General Configuration')
      .addFields(
        { name: '🛡️ Default Auto-Join Role', value: `\`${guildConfig.defaultRole}\``, inline: true },
        { name: '📏 Max Squad Capacity', value: `\`${guildConfig.maxSquadSize}\``, inline: true },
        { name: '📍 Target Deployment Channel', value: guildConfig.operationsChannelId ? `<#${guildConfig.operationsChannelId}>` : '`Not Set`' }
      );
  } else if (section === 'perms') {
    const auth = (guildConfig.authorizedRoles || []).map(r => `• <@&${r}>`).join('\n') || '_None_';
    const creators = (guildConfig.eventCreatorRoles || []).map(r => `• <@&${r}>`).join('\n') || '_None_';
    embed.setTitle('🛡️ Permissions Registry')
      .addFields(
        { name: 'Admin Privileges', value: auth, inline: true },
        { name: 'Event Creator Privileges', value: creators, inline: true }
      );
  } else if (section === 'roles') {
    const roles = (guildConfig.selectableRoles || []).map(r => `• **${r}**`).join('\n') || '> _None_';
    embed.setTitle('🎯 Tactical Role Registry')
      .setDescription('**Operational Roles available for recruitment:**\n\n' + roles + '\n\n*Note: Squad Lead is dynamically assigned based on permissions.*');
  } else if (section === 'templates') {
    const count = (guildConfig.templates || []).length;
    embed.setTitle('📂 Mission Templates')
      .setDescription(`Total Saved Templates: \`${count}\``)
      .addFields({ name: 'Usage', value: 'Templates allow rapid operation deployment via the `/op create` flow.' });
  }
 
  return embed;
}
 
function getOpByMessage(data, messageId) {
  return Object.values(data.operations).find(op => op.messageId === messageId) || null;
}
 
function getNextSquadName(op) {
  const existing = op.squads.map(s => s.name);
  for (const name of squadNames) {
    if (!existing.includes(name)) return name;
  }
  return null;
}
 
function findUserSquad(op, userId) {
  return op.squads.find(s => s.members.some(m => m.userId === userId));
}
 
function ensureUserStats(data, userId) {
  if (!data.users[userId]) {
    data.users[userId] = { joined: 0, attended: 0, medals: [], passedBCT: false, promotionNotes: "", ledOps: 0, recruits: 0, councilNote: "" };
  }
  if (data.users[userId].medals === undefined) data.users[userId].medals = [];
  if (data.users[userId].passedBCT === undefined) data.users[userId].passedBCT = false;
  if (data.users[userId].promotionNotes === undefined) data.users[userId].promotionNotes = "";
  if (data.users[userId].ledOps === undefined) data.users[userId].ledOps = 0;
  if (data.users[userId].recruits === undefined) data.users[userId].recruits = 0;
  if (data.users[userId].councilNote === undefined) data.users[userId].councilNote = "";
  return data.users[userId];
}
 
async function updateOperationMessage(client, op) {
  try {
    const channel = await client.channels.fetch(op.channelId);
    if (!channel) return;
    const message = await channel.messages.fetch(op.messageId);
    if (!message) return;
    await message.edit({ embeds: [buildOperationEmbed(op)], components: [buildActionRow(op)] });
  } catch (err) {
    console.error('Failed to update operation message:', err);
  }
}
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildScheduledEvents
  ],
  partials: [Partials.Channel]
});
 
client.once(Events.ClientReady, async () => {
  console.log(`ARCUS ready: ${client.user.tag}`);
  client.user.setActivity('Operational Logs', { type: ActivityType.Watching });
 
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commandData = new SlashCommandBuilder()
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
      sub.setName('profile')
        .setDescription('View your detailed operational service record')
        .addUserOption(opt => opt.setName('target').setDescription('The user to view').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('leaderboard')
        .setDescription('View the top performing operators in the system'))
    .addSubcommand(sub =>
      sub.setName('clear_stats')
        .setDescription('Admin: Permanently wipe all attendance statistics'));
 
  const commands = [commandData.toJSON()];
 
  try {
    const guilds = client.guilds.cache.map(g => g.id);
 
    if (guilds.length === 0) {
      console.warn(`ARCUS Warning: Bot is not in any guilds. Command sync skipped.`);
      return;
    }
 
    for (const gId of guilds) {
      console.log(`ARCUS: Syncing commands for Guild: ${gId}`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gId), { body: commands })
        .catch(err => console.error(`Command Sync Failed for ${gId}:`, err));
    }
    console.log('ARCUS: All guild commands synchronized.');
  } catch (error) {
    console.error('Failed registering commands:', error);
  }

  // Reminder background task
  setInterval(async () => {
    const data = loadData();
    const now = Date.now();
    let changed = false;

    for (const opId in data.operations) {
      const op = data.operations[opId];
      if (op.locked || !op.reminderMinutes || op.reminderSent) continue;
      const startTime = parseOpTime(op.time);
      if (!startTime || isNaN(startTime)) continue;
      const reminderThreshold = startTime - (op.reminderMinutes * 60000);
      if (now >= reminderThreshold) {
        const participants = op.participants || [];
        for (const p of participants) { 
          try {
            const user = await client.users.fetch(p.userId);
            await user.send(`🔔 **ARCUS Reminder**: Operation **${op.name}** starts in approximately ${op.reminderMinutes} minutes!`);
          } catch (e) {
            console.error(`Failed to DM reminder to ${p.userId}`);
          }
        }
        op.reminderSent = true;
        changed = true;
      }
    }
    if (changed) saveData(data);
  }, 60000);
});
 
client.on('interactionCreate', async (interaction) => {
  const data = loadData();
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'op') return;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'create') {
        const member = interaction.member;
        if (!canCreateEvent(member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized role.', flags: [MessageFlags.Ephemeral] });
 
        const guildConfig = getGuildConfig(interaction.guildId);
        const targetChannelId = guildConfig.operationsChannelId || interaction.channelId;
 
        try {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`op:setup:${interaction.guildId}:${targetChannelId}`)
              .setLabel('📝 Setup Operation')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`op:template_list:${interaction.guildId}:${targetChannelId}`)
              .setLabel('📂 Use Template')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!(guildConfig.templates && guildConfig.templates.length > 0))
          );
 
          const dmEmbed = new EmbedBuilder()
            .setTitle('ARCUS: Operation Creation Menu')
            .setDescription(`To create a new operation for <#${targetChannelId}>, click the button below to open the configuration form.`)
            .setColor(0xed4245);
 
          await interaction.user.send({ embeds: [dmEmbed], components: [row] });
          return interaction.reply({ content: 'ARCUS: Configuration menu sent to your DMs.', flags: [MessageFlags.Ephemeral] });
        } catch (err) {
          console.error('ARCUS: DM failed:', err);
          return interaction.reply({ content: 'ARCUS: Could not DM you. Please ensure your DMs are open.', flags: [MessageFlags.Ephemeral] });
        }
      }
 
      if (subcommand === 'end') {
        const member = interaction.member;
        if (!isAuthorized(member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Unauthorized role.', flags: [MessageFlags.Ephemeral] });
        }
 
        const opId = interaction.options.getString('id');
        const op = getOpById(data, opId);
        if (!op) {
          return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        }
        if (op.locked) {
          return interaction.reply({ content: 'ARCUS: Operation already ended.', flags: [MessageFlags.Ephemeral] });
        }
 
        op.locked = true;
        data.operations[opId] = op;
        saveData(data);
 
        await updateOperationMessage(client, op); 
 
        if (op.scheduledEventId) {
          try {
            const guild = await client.guilds.fetch(op.guildId);
            await guild.scheduledEvents.delete(op.scheduledEventId);
          } catch (e) {
            console.error('Failed to delete scheduled event on end:', e);
          }
        }
 
        try {
          const dm = await interaction.user.createDM();
          const options = op.participants.map(user => ({ label: user.username || 'Unknown', value: user.userId }));
          if (options.length === 0) {
            await dm.send('ARCUS: No participants to mark attendance.');
          } else {
            const attendanceMenu = new StringSelectMenuBuilder()
              .setCustomId(`op:attendance:${opId}`)
              .setPlaceholder('Select attendees')
              .setMinValues(0)
              .setMaxValues(options.length)
              .addOptions(options);
            const row = new ActionRowBuilder().addComponents(attendanceMenu);
            await dm.send({ content: 'ARCUS: Mark who attended.', components: [row] });
          }
          await interaction.reply({ content: 'ARCUS: Operation locked and attendance DM sent to creator.', flags: [MessageFlags.Ephemeral] });
        } catch (err) {
          console.error('ARCUS: DM failed:', err);
          await interaction.reply({ content: 'ARCUS: Operation locked, but failed to DM creator. Check DM settings.', flags: [MessageFlags.Ephemeral] });
        }
        return;
      }
 
      if (subcommand === 'delete') {
        const opId = interaction.options.getString('id');
        const op = getOpById(data, opId);
        if (!op) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
 
        try {
          const channel = await client.channels.fetch(op.channelId);
          const msg = await channel.messages.fetch(op.messageId);
          await msg.delete();
          if (op.scheduledEventId) {
            const guild = await client.guilds.fetch(op.guildId);
            await guild.scheduledEvents.delete(op.scheduledEventId).catch(() => {});
          }
        } catch (e) {}
 
        delete data.operations[opId];
        saveData(data);
        return interaction.reply({ content: `ARCUS: Operation **${op.name}** and associated data deleted.`, flags: [MessageFlags.Ephemeral] });
      }
 
      const group = interaction.options.getSubcommandGroup(false);
 
      if (group === 'admin') {
        if (!interaction.member.permissions.has('Administrator') && !isAuthorized(interaction.member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Master Admin permissions required.', flags: [MessageFlags.Ephemeral] });
        }
        const guildConfig = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
        if (subcommand === 'grant') {
          if (guildConfig.authorizedRoles.includes(role.id)) return interaction.reply({ content: 'Role is already admin.', flags: [MessageFlags.Ephemeral] });
          guildConfig.authorizedRoles.push(role.id);
        } else {
          guildConfig.authorizedRoles = guildConfig.authorizedRoles.filter(id => id !== role.id);
        }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Admin list updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (group === 'creator') {
        const member = interaction.member;
        if (!isAuthorized(member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Unauthorized role to manage event creation permissions.', flags: [MessageFlags.Ephemeral] });
        }
        const guildConfig = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
 
        if (subcommand === 'grant') {
          if (!guildConfig.eventCreatorRoles.includes(role.id)) guildConfig.eventCreatorRoles.push(role.id);
        } else {
          guildConfig.eventCreatorRoles = guildConfig.eventCreatorRoles.filter(id => id !== role.id);
        }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Creator permissions updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (group === 'tactical') {
        if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const guildConfig = getGuildConfig(interaction.guildId);
        const roleName = interaction.options.getString('name');
 
        if (subcommand === 'add') {
          if (!guildConfig.selectableRoles.includes(roleName)) guildConfig.selectableRoles.push(roleName);
          interaction.reply({ content: `ARCUS: **${roleName}** added to Tactical Registry.`, flags: [MessageFlags.Ephemeral] });
        } else if (subcommand === 'remove') {
          guildConfig.selectableRoles = guildConfig.selectableRoles.filter(r => r !== roleName);
          interaction.reply({ content: `ARCUS: **${roleName}** removed from Tactical Registry.`, flags: [MessageFlags.Ephemeral] });
        } else {
          const list = guildConfig.selectableRoles.map(r => `• ${r}`).join('\n') || '_None_';
          interaction.reply({ content: `**Tactical Registry:**\n${list}`, flags: [MessageFlags.Ephemeral] });
        }
        saveConfig();
        return;
      }
 
      if (group === 'template') {
        if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const guildConfig = getGuildConfig(interaction.guildId);
 
        if (subcommand === 'add') {
          const modal = new ModalBuilder().setCustomId('op:template:add_modal').setTitle('Create Mission Template');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_name').setLabel('Template Name').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_desc').setLabel('Default Briefing').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_pings').setLabel('Default Pings (Roles)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_reminder').setLabel('Reminder (Mins)').setStyle(TextInputStyle.Short).setValue('30'))
          );
          return await interaction.showModal(modal);
        } else if (subcommand === 'remove') {
          const idx = interaction.options.getInteger('index');
          if (guildConfig.templates && guildConfig.templates[idx]) {
            const removed = guildConfig.templates.splice(idx, 1);
            saveConfig();
            return interaction.reply({ content: `ARCUS: Template **${removed[0].name}** deleted.`, flags: [MessageFlags.Ephemeral] });
          }
          return interaction.reply({ content: 'ARCUS: Invalid template index.', flags: [MessageFlags.Ephemeral] });
        } else {
          const list = (guildConfig.templates || []).map((t, i) => `\`[${i}]\` **${t.name}**: ${t.description.substring(0, 40)}...`).join('\n') || '_No templates saved._';
          return interaction.reply({ content: `**Mission Templates:**\n${list}`, flags: [MessageFlags.Ephemeral] });
        }
      }
 
      if (subcommand === 'aar') {
        const opId = interaction.options.getString('id');
        const op = getOpById(data, opId);
 
        if (!op) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        if (interaction.user.id !== op.creatorId && !interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'ARCUS: Only the creator or admins can file an AAR.', flags: [MessageFlags.Ephemeral] });
        }
 
        const modal = new ModalBuilder().setCustomId(`op:modal:aar:${opId}`).setTitle(`AAR: ${op.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_phases').setLabel("What happened (Phases / Timeline)").setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('e.g. Phase 1: Infiltration successful...')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_performance').setLabel("Personnel Evaluation / Performance").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('e.g. Medic handled mass casualty incident perfectly...'))
        );
 
        return await interaction.showModal(modal);
      }
 
      if (subcommand === 'set_channel') {
        if (!isAuthorized(interaction.member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Unauthorized role.', flags: [MessageFlags.Ephemeral] });
        }
        const guildConfig = getGuildConfig(interaction.guildId);
        const channel = interaction.options.getChannel('channel');
        guildConfig.operationsChannelId = channel.id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: Operations channel set to <#${channel.id}>.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (subcommand === 'stats') {
        const target = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        const stats = ensureUserStats(data, target.id);
        const currentRank = getRank(targetMember, stats);
        const nextRank = ranks[ranks.indexOf(currentRank) + 1] || null;
        const opsToNextRank = nextRank && !nextRank.appointed ? `\`${Math.max(0, nextRank.minAttended - (stats.attended || 0))}\`` : 'N/A';
        const embed = new EmbedBuilder()
          .setTitle(`ARCUS Service Record: ${targetMember?.nickname || target.username}`)
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: 'Rank', value: `**${currentRank.name}**`, inline: true },
            { name: 'Ops to Next Rank', value: opsToNextRank, inline: true }
          )
          .setColor(0x5865f2);
 
        return interaction.reply({ embeds: [embed] });
      }
 
      if (subcommand === 'profile') {
        const targetUser = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        const displayName = targetMember?.nickname || targetUser.displayName || targetUser.username;
        const stats = ensureUserStats(data, targetUser.id);
        const currentRank = getRank(targetMember, stats);
        const nextRank = ranks[ranks.indexOf(currentRank) + 1] || null;
        let progressText = '*Max Rank Achieved*';
        let opsToNextRank = 'N/A';
 
        if (nextRank) {
          if (nextRank.appointed) {
            progressText = `*Next Promotion: ${nextRank.name} (Appointed Position)*`;
            opsToNextRank = 'N/A';
          } else {
            const reqs = [];
            const opsNeeded = Math.max(0, nextRank.minAttended - (stats.attended || 0));
            opsToNextRank = `\`${opsNeeded}\``;
 
            if (opsNeeded > 0) reqs.push(`${opsNeeded} Ops`);
            if (nextRank.requireBCT && !stats.passedBCT) reqs.push('BCT');
            if (nextRank.minLed && (stats.ledOps || 0) < nextRank.minLed) reqs.push(`${nextRank.minLed - (stats.ledOps || 0)} Led Ops`);
            if (nextRank.minRecruits && (stats.recruits || 0) < nextRank.minRecruits) reqs.push(`${nextRank.minRecruits - (stats.recruits || 0)} Recruits`);
 
            progressText = `*Next Promotion: ${nextRank.name} (${reqs.length > 0 ? reqs.join(', ') : 'Eligible'})*`;
          }
        }
 
        const councilRankIndex = ranks.findIndex(r => r.name === 'Council');
        const isCouncilOrAbove = ranks.indexOf(currentRank) >= councilRankIndex;
 
        const embed = new EmbedBuilder()
          .setTitle(`ARCUS Service Record: ${displayName}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .addFields(
            { name: 'Rank', value: `**${currentRank.name}**`, inline: true },
            { name: 'Ops to Next Rank', value: opsToNextRank, inline: true },
            { name: 'Personnel Stats', value: `Led: \`${stats.ledOps || 0}\`\nRecruits: \`${stats.recruits || 0}\``, inline: false },
            { name: 'Promotion Req.', value: progressText, inline: false }
          );
 
        if (currentRank.name === 'Recruit') {
          embed.addFields({ name: 'Qualification Status', value: `BCT: ${stats.passedBCT ? '✅ Passed' : '❌ Pending'}\nNotes: ${stats.promotionNotes || '_No notes record_'}`, inline: false });
        }
 
        if (isCouncilOrAbove) {
          embed.addFields({ name: 'Council Assignment', value: stats.councilNote || '_No assignment noted_', inline: false });
        }
 
        embed
          .setColor(0x5865f2)
          .setFooter({ text: 'Operational Excellence through Data Synchronization' })
          .setTimestamp();

        const components = [];
        if (isAuthorized(interaction.member, interaction.guildId)) {
          const row = new ActionRowBuilder();
          
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`op:prof_edit:${targetUser.id}`)
              .setLabel('📝 Edit Record')
              .setStyle(ButtonStyle.Secondary)
          );

          if (nextRank && !nextRank.appointed) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`op:prof_promote:${targetUser.id}`)
                .setLabel('🎖️ Promote')
                .setStyle(ButtonStyle.Primary)
            );
          }

          if (currentRank.name === 'Recruit' && !stats.passedBCT) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`op:bct_pass:${targetUser.id}`)
                .setLabel('✅ Mark BCT Passed')
                .setStyle(ButtonStyle.Success)
            );
          }
          components.push(row);
        }

        return interaction.reply({ embeds: [embed], components });
      }
 
      if (subcommand === 'leaderboard') {
 
        const userEntries = Object.entries(data.users);
        if (userEntries.length === 0) {
          return interaction.reply({ content: 'ARCUS: No operational data recorded yet.', flags: [MessageFlags.Ephemeral] });
        }
 
        const topOperators = userEntries
          .map(([id, rawStats]) => ({ id, stats: rawStats, attended: rawStats.attended || 0 }))
          .sort((a, b) => b.stats.attended - a.stats.attended)
          .slice(0, 10);
 
        let leaderboardText = '';
        for (let i = 0; i < topOperators.length; i++) {
          const entry = topOperators[i];
          const user = await client.users.fetch(entry.id).catch(() => ({ username: 'Unknown Operator' }));
          const member = await interaction.guild.members.fetch(entry.id).catch(() => null);
          const finalName = member?.nickname || user.username;
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
          const rank = getRank(member, entry.stats);
          leaderboardText += `${medal} **${finalName}** — ${rank.name}\n`;
        }
 
        const embed = new EmbedBuilder()
          .setTitle('🏆 ARCUS Operational Leaderboard')
          .setDescription(leaderboardText)
          .setColor(0xFFA500)
          .setFooter({ text: 'Top 10 Operators based on successful attendance' });
 
        return interaction.reply({ embeds: [embed] });
      }
 
      if (subcommand === 'clear_stats') {
        if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Admin privileges required.', flags: [MessageFlags.Ephemeral] });
        data.users = {};
        saveData(data);
        return interaction.reply({ content: 'ARCUS: All attendance statistics have been wiped.', flags: [MessageFlags.Ephemeral] });
      }
 
      if (subcommand === 'settings') {
        if (!isAuthorized(interaction.member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Admin permissions required.', flags: [MessageFlags.Ephemeral] });
        }
 
        const guildConfig = getGuildConfig(interaction.guildId);
        const embed = buildSettingsEmbed(guildConfig);
 
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:view:gen').setLabel('General').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
          new ButtonBuilder().setCustomId('settings:view:roles').setLabel('Tactical').setStyle(ButtonStyle.Secondary).setEmoji('🎯'),
          new ButtonBuilder().setCustomId('settings:view:perms').setLabel('Access').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
          new ButtonBuilder().setCustomId('settings:view:templates').setLabel('Mission').setStyle(ButtonStyle.Secondary).setEmoji('📂')
        );
 
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:main').setLabel('Home').setStyle(ButtonStyle.Primary).setEmoji('🏠'),
          new ButtonBuilder().setCustomId(`settings:edit:main`).setLabel('Edit').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('settings:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🛑')
        );
 
        return interaction.reply({
          embeds: [embed],
          components: [row, row2],
          flags: [MessageFlags.Ephemeral]
        });
      }
 
    } else if (interaction.isButton()) {
      const customId = interaction.customId;
      const parts = customId.split(':');
      const namespace = parts[0];
      const action = parts[1];
      const targetId = parts[2];
 
      if (namespace === 'op' && action === 'template_list') {
        const guildId = parts[2] || interaction.guildId;
        const targetChannelId = parts[3];
        const guildConfig = getGuildConfig(guildId);
        const options = guildConfig.templates.map((t, idx) => ({ label: t.name, description: t.description.substring(0, 50), value: `template_${idx}_${guildId || 'null'}_${targetChannelId}` }));
        const select = new StringSelectMenuBuilder().setCustomId(`op:load_template`).setPlaceholder('Select a template to use').addOptions(options);
        return interaction.reply({ content: 'ARCUS: Select a template:', components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] });
      }
 
      if (namespace === 'settings' && action === 'edit') {
        if (targetId === 'gen') {
          const guildConfig = getGuildConfig(interaction.guildId);
          const modal = new ModalBuilder().setCustomId('settings:modal:gen').setTitle('ARCUS: General Configuration');
          const sizeInput = new TextInputBuilder().setCustomId('max_size').setLabel('Max Squad Size (1-10)').setStyle(TextInputStyle.Short).setValue((guildConfig.maxSquadSize || 4).toString()).setPlaceholder('e.g. 4');
          const defRoleInput = new TextInputBuilder().setCustomId('def_role').setLabel('Default Auto-Join Role').setStyle(TextInputStyle.Short).setValue((guildConfig.defaultRole || 'Point Man').toString()).setPlaceholder('e.g. Point Man');
          modal.addComponents(new ActionRowBuilder().addComponents(sizeInput), new ActionRowBuilder().addComponents(defRoleInput));
          return interaction.showModal(modal);
        }
 
        if (targetId === 'roles') {
          const modal = new ModalBuilder().setCustomId('settings:modal:roles').setTitle('ARCUS: Edit Tactical Registry');
          const addInput = new TextInputBuilder().setCustomId('add_role').setLabel('Add Role (Optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Marksman');
          const removeInput = new TextInputBuilder().setCustomId('remove_role').setLabel('Remove Role (Optional - Exact Name)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Overwatch');
          modal.addComponents(new ActionRowBuilder().addComponents(addInput), new ActionRowBuilder().addComponents(removeInput));
          return interaction.showModal(modal);
        }
 
        let content = "Use `/op tactical add/remove` to manage tactical roles.\nUse `/op admin grant/revoke` to manage admins.";
        if (targetId === 'templates') content = "Use `/op template add/remove` to manage mission templates.";
        if (targetId === 'perms') content = "Use `/op creator grant/revoke` to manage who can create operations.";
 
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle('Manual Control Required').setDescription(content).setColor(0xFFFF00)],
          flags: [MessageFlags.Ephemeral]
        });
      }
 
      if (namespace === 'settings' && (action === 'view' || action === 'main')) {
        const category = action === 'view' ? targetId : 'main';
        const guildConfig = getGuildConfig(interaction.guildId);
        const embed = buildSettingsEmbed(guildConfig, category);
 
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:view:gen').setLabel('General').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
          new ButtonBuilder().setCustomId('settings:view:roles').setLabel('Tactical').setStyle(ButtonStyle.Secondary).setEmoji('🎯'),
          new ButtonBuilder().setCustomId('settings:view:perms').setLabel('Access').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
          new ButtonBuilder().setCustomId('settings:view:templates').setLabel('Mission').setStyle(ButtonStyle.Secondary).setEmoji('📂')
        );
 
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:main').setLabel('Home').setStyle(ButtonStyle.Primary).setEmoji('🏠'),
          new ButtonBuilder().setCustomId(`settings:edit:${category}`).setLabel('Edit').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('settings:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🛑')
        );
 
        return interaction.update({ embeds: [embed], components: [row, row2] });
      }
 
      if (namespace === 'settings' && action === 'close') {
        await interaction.deferUpdate();
        return interaction.deleteReply();
      }
 
      if (namespace === 'op' && action === 'setup') {
        try {
          const guildId = parts[2] || interaction.guildId;
          const sourceChannelId = parts[3];
 
          const modal = new ModalBuilder()
            .setCustomId(`op:modal:submit:${guildId}:${sourceChannelId}`)
            .setTitle('ARCUS: New Operation Configuration');
 
          const nameInput = new TextInputBuilder().setCustomId('op_name').setLabel("Operation Name").setStyle(TextInputStyle.Short).setRequired(true);
          const timeInput = new TextInputBuilder().setCustomId('op_time').setLabel("Start Time").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Friday 20:00 UTC');
          const descInput = new TextInputBuilder().setCustomId('op_description').setLabel("Briefing / Objective").setStyle(TextInputStyle.Paragraph).setRequired(true);
          const pingsInput = new TextInputBuilder().setCustomId('op_pings').setLabel("Roles to Ping (Optional)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Admin, Moderator');
          const reminderInput = new TextInputBuilder().setCustomId('op_reminder').setLabel("Reminder Offset (Minutes)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. 30');
 
          modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(timeInput),
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(pingsInput),
            new ActionRowBuilder().addComponents(reminderInput)
          );
          return interaction.showModal(modal);
        } catch (e) {
          return interaction.reply({ content: 'ARCUS: Failed to open setup menu. Please ensure your DMs are open.', flags: [MessageFlags.Ephemeral] });
        }
      }
 
      if (namespace === 'op' && action === 'bct_pass') {
        if (!isAuthorized(interaction.member, interaction.guildId)) {
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        }
        const data = loadData();
        const stats = ensureUserStats(data, targetId);
        stats.passedBCT = true;
        saveData(data);
        return interaction.reply({ content: `✅ Successfully marked <@${targetId}> as BCT Passed.`, flags: [MessageFlags.Ephemeral] });
      }

      if (namespace === 'op' && action === 'prof_edit') {
        if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const ustats = ensureUserStats(data, targetId);

        const member = await interaction.guild.members.fetch(targetId).catch(() => null);
        const currentRank = getRank(member, ustats);
        const modal = new ModalBuilder().setCustomId(`op:modal:prof_edit:${targetId}`).setTitle(`Edit Record: ${currentRank.name}`);
        const rows = [
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('attended_ops').setLabel('Attended Ops').setStyle(TextInputStyle.Short).setValue((ustats.attended || 0).toString())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('led_ops').setLabel('Led Ops').setStyle(TextInputStyle.Short).setValue((ustats.ledOps || 0).toString())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('recruit_count').setLabel('Recruits').setStyle(TextInputStyle.Short).setValue((ustats.recruits || 0).toString())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prom_notes').setLabel('Promotion Notes').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(ustats.promotionNotes || ''))
        ];

        if (currentRank.name === 'Recruit') rows.unshift(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bct_status').setLabel('BCT Passed? (yes/no)').setStyle(TextInputStyle.Short).setValue(ustats.passedBCT ? 'yes' : 'no')));
        else if (ranks.indexOf(currentRank) >= ranks.findIndex(r => r.name === 'Council')) rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('council_note').setLabel('Council Assignment').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(ustats.councilNote || '')));
 
        modal.addComponents(rows);
        return interaction.showModal(modal);
      }
 
      if (namespace === 'op' && action === 'prof_promote') {
        if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'Unauthorized.', flags: [MessageFlags.Ephemeral] });
        
        await interaction.deferUpdate(); // Now we defer because we're authorized to proceed
        const stats = ensureUserStats(data, targetId);
        const member = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (!member) return interaction.followUp({ content: 'Operator no longer in server.', flags: [MessageFlags.Ephemeral] });

        const currentRank = getRank(member, stats);
        const rankIndex = ranks.indexOf(currentRank);
        const nextRank = ranks[rankIndex + 1];

        if (!nextRank) return interaction.followUp({ content: 'Operator is at max rank.', flags: [MessageFlags.Ephemeral] });
        if (nextRank.appointed) return interaction.followUp({ content: 'This rank is an appointed position and cannot be reached via standard promotion.', flags: [MessageFlags.Ephemeral] });
 
        if (nextRank.name === 'Sergeant' && !stats.passedBCT) return interaction.followUp({ content: 'Ineligible: Operator has not passed BCT.', flags: [MessageFlags.Ephemeral] });
        if (stats.attended < nextRank.minAttended) return interaction.followUp({ content: `Ineligible: Needs ${nextRank.minAttended} completed ops.`, flags: [MessageFlags.Ephemeral] });

        const ledOps = stats.ledOps || 0;
        const recruits = stats.recruits || 0;
        if (nextRank.minLed && ledOps < nextRank.minLed) return interaction.followUp({ content: `Ineligible: Needs to lead ${nextRank.minLed} ops (Current: ${ledOps}).`, flags: [MessageFlags.Ephemeral] });
        if (nextRank.minRecruits && recruits < nextRank.minRecruits) return interaction.followUp({ content: `Ineligible: Needs ${nextRank.minRecruits} recruits (Current: ${recruits}).`, flags: [MessageFlags.Ephemeral] });
 
        const role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === nextRank.name.toLowerCase());
        if (role) {
          const currentRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === currentRank.name.toLowerCase());
          if (currentRole && currentRole.id !== role.id) {
            await member.roles.remove(currentRole).catch(e => console.error(`Failed to remove old rank role ${currentRole.name}:`, e));
          }
          await member.roles.add(role).catch(e => console.error(`Failed to add new rank role ${role.name}:`, e));
        }

        await syncNickname(member, nextRank);
 
        try {
          await member.send(`🎖️ **ARCUS Promotion**: You have been promoted to **${nextRank.name}**! Service record updated.`);
        } catch (e) {}
 
        return interaction.followUp({ content: `✅ Operator <@${targetId}> promoted to **${nextRank.name}**.` });
      }
 
      // Handle operation specific buttons
      if (namespace !== 'op') return;
 
      await interaction.deferUpdate().catch(() => {});
 
      const op = getOpById(data, targetId);
      if (!op) return interaction.followUp({ content: 'ARCUS: Operation not found or expired.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      if (op.locked) {
        return interaction.followUp({ content: 'ARCUS: Operation is locked.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
      const guildConfig = getGuildConfig(op.guildId);
 
      if (action === 'join') {
        const existing = findUserSquad(op, interaction.user.id);
        if (existing) {
          return interaction.followUp({ content: 'ARCUS: You are already in a squad.', flags: [MessageFlags.Ephemeral] });
        }
        const squad = op.squads.find(s => s.members.length < (guildConfig.maxSquadSize || 4));
        if (!squad) {
          return interaction.followUp({ content: 'ARCUS: Operation at capacity. Wait for new squad.', flags: [MessageFlags.Ephemeral] });
        }
 
        const roleToAssign = (interaction.user.id === op.creatorId) ? "Squad Lead" : (guildConfig.defaultRole || "Point Man");
 
        squad.members.push({
          userId: interaction.user.id,
          username: interaction.user.username,
          role: roleToAssign
        });
        if (!op.participants.find(u => u.userId === interaction.user.id)) {
          op.participants.push({ userId: interaction.user.id, username: interaction.user.username });
        }
        data.operations[targetId] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: 'ARCUS: Operator assigned.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
 
      if (action === 'leave') {
        const squad = findUserSquad(op, interaction.user.id);
        if (!squad) {
          return interaction.followUp({ content: 'ARCUS: You are not in this operation.', flags: [MessageFlags.Ephemeral] });
        }
        squad.members = squad.members.filter(m => m.userId !== interaction.user.id);
 
        if (squad.members.length === 0 && squad.name !== 'Alpha') {
          op.squads = op.squads.filter(s => s.name !== squad.name);
        }
 
        op.participants = op.participants.filter(p => p.userId !== interaction.user.id);
        data.operations[targetId] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: 'ARCUS: You have left operation.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      }
 
      if (action === 'role') {
        const selectable = guildConfig.selectableRoles || ["Point Man", "Overwatch", "Medic", "Demolitions"];
 
        const options = selectable.map(role => ({ label: role, value: role }));
        const select = new StringSelectMenuBuilder()
          .setCustomId(`op:roleselect:${targetId}`)
          .setPlaceholder('Choose a role')
          .addOptions(options)
          .setMinValues(1)
          .setMaxValues(1);
        const row = new ActionRowBuilder().addComponents(select);
        return interaction.followUp({ content: 'ARCUS: Select your role.', components: [row], flags: [MessageFlags.Ephemeral] });
      }
 
      if (action === 'squad') {
        if (!canCreateSquad(interaction.member, op.guildId)) {
          return interaction.followUp({ content: 'ARCUS: You do not have permission to create squads.', flags: [MessageFlags.Ephemeral] });
        }
 
        const isPreviousFull = op.squads.every(s => s.members.length >= (guildConfig.maxSquadSize || 4));
        if (!isPreviousFull) {
          return interaction.followUp({ content: `ARCUS: All existing squads must be full (${guildConfig.maxSquadSize || 4} operators) before creating a new one.`, flags: [MessageFlags.Ephemeral] });
        }
 
        const nextName = getNextSquadName(op);
        if (!nextName) {
          return interaction.followUp({ content: 'ARCUS: Tactical limit reached. No more squads available.', flags: [MessageFlags.Ephemeral] });
        }
 
        const oldSquad = findUserSquad(op, interaction.user.id);
        if (oldSquad) {
          oldSquad.members = oldSquad.members.filter(m => m.userId !== interaction.user.id);
          if (oldSquad.members.length === 0 && oldSquad.name !== 'Alpha') {
            op.squads = op.squads.filter(s => s.name !== oldSquad.name);
          }
        }
 
        op.squads.push({
          name: nextName,
          members: [{
            userId: interaction.user.id,
            username: interaction.user.username,
            role: "Squad Lead"
          }]
        });
 
        if (!op.participants.find(u => u.userId === interaction.user.id)) {
          op.participants.push({ userId: interaction.user.id, username: interaction.user.username });
        }
 
        data.operations[targetId] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: `ARCUS: Squad ${nextName} initialized.`, flags: [MessageFlags.Ephemeral] });
      }
 
    } else if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      const parts = customId.split(':');
 
      if (customId === 'op:load_template') {
        const vals = interaction.values[0].split('_');
        const idx = vals[1];
        const guildId = vals.length > 3 ? vals[2] : null;
        const channelId = vals.length > 3 ? vals[3] : vals[2];
 
        const guildConfig = getGuildConfig(guildId);
        const template = guildConfig.templates[parseInt(idx)];
 
        const modal = new ModalBuilder()
          .setCustomId(`op:modal:submit:${guildId || 'null'}:${channelId}`)
          .setTitle(`ARCUS: Template - ${template.name}`);
 
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_name').setLabel("Operation Name").setStyle(TextInputStyle.Short).setValue(template.name)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_time').setLabel("Start Time").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Friday 20:00 UTC')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_description').setLabel("Briefing / Objective").setStyle(TextInputStyle.Paragraph).setValue(template.description)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_pings').setLabel("Roles to Ping (Optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(template.pings || '')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_reminder').setLabel("Reminder Offset (Minutes)").setStyle(TextInputStyle.Short).setRequired(false).setValue(template.reminder?.toString() || '30'))
        );
        return interaction.showModal(modal);
      }
 
      await interaction.deferUpdate().catch(() => {});
 
      if (parts[1] === 'roleselect') {
        const targetOpId = parts[2];
        const currentOp = getOpById(data, targetOpId);
        if (!currentOp || currentOp.locked) {
          return interaction.followUp({ content: 'ARCUS: Operation not found or locked.', flags: [MessageFlags.Ephemeral] });
        }
        const squad = findUserSquad(currentOp, interaction.user.id);
        if (!squad) {
          return interaction.followUp({ content: 'ARCUS: Join operation first before selecting role.', flags: [MessageFlags.Ephemeral] });
        }
        const selectedRole = interaction.values[0];
 
        const caps = { 'Medic': 1, 'Overwatch': 1, 'Demolitions': 1, 'Squad Lead': 1 };
        if (caps[selectedRole]) {
          const count = squad.members.filter(m => m.role === selectedRole && m.userId !== interaction.user.id).length;
          if (count >= caps[selectedRole]) {
            return interaction.followUp({ content: `ARCUS: This squad already has a ${selectedRole}.`, flags: [MessageFlags.Ephemeral] });
          }
        }
 
        if (selectedRole === 'Squad Lead' && !canCreateEvent(interaction.member, currentOp.guildId)) {
          return interaction.followUp({ content: 'ARCUS: Only users with Event Creator permissions can select the Squad Lead role.', flags: [MessageFlags.Ephemeral] });
        }
 
        for (const member of squad.members) {
          if (member.userId === interaction.user.id) {
            member.role = selectedRole;
            break;
          }
        }
        data.operations[targetOpId] = currentOp;
        saveData(data);
        await updateOperationMessage(client, currentOp);
        return interaction.followUp({ content: `ARCUS: Role set to ${selectedRole}.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (parts[1] === 'attendance') {
        const targetOpId = parts[2];
        const currentOp = getOpById(data, targetOpId);
        if (!currentOp) {
          return interaction.followUp({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.user.id !== currentOp.creatorId) {
          return interaction.followUp({ content: 'ARCUS: Only creator can confirm attendance.', flags: [MessageFlags.Ephemeral] });
        }
 
        const attendedIds = new Set(interaction.values);
        currentOp.attendance = {};
        for (const participant of currentOp.participants) {
          const attended = attendedIds.has(participant.userId);
          currentOp.attendance[participant.userId] = attended ? 'Attended' : 'Absent';
          const userStats = ensureUserStats(data, participant.userId);
          userStats.joined += 1;
          if (attended) {
            userStats.attended += 1;
          }
        }
 
        data.operations[targetOpId] = currentOp;
        saveData(data);
 
        const targetChannel = await client.channels.fetch(currentOp.channelId);
        if (targetChannel) {
          await targetChannel.send(`ARCUS: Attendance recorded for operation ${currentOp.name}.`);
        }
 
        await interaction.followUp({ content: 'ARCUS: Attendance confirmed and tracked.', flags: [MessageFlags.Ephemeral] });
        return;
      }
 
    } else if (interaction.isModalSubmit()) {
      const customId = interaction.customId;
      const parts = customId.split(':');
 
      if (customId === 'op:template:add_modal') {
        const name = interaction.fields.getTextInputValue('tmpl_name');
        const description = interaction.fields.getTextInputValue('tmpl_desc');
        const pings = interaction.fields.getTextInputValue('tmpl_pings');
        const reminder = parseInt(interaction.fields.getTextInputValue('tmpl_reminder')) || 30;
        const guildConfig = getGuildConfig(interaction.guildId);
        if (!guildConfig.templates) guildConfig.templates = [];
        guildConfig.templates.push({ name, description, pings, reminder });
        saveConfig();
        return interaction.reply({ content: `ARCUS: Mission template **${name}** has been registered.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (customId === 'settings:modal:roles') {
        const guildConfig = getGuildConfig(interaction.guildId);
        const add = interaction.fields.getTextInputValue('add_role').trim();
        const remove = interaction.fields.getTextInputValue('remove_role').trim();
        let feedback = [];
 
        if (add) {
          if (!guildConfig.selectableRoles.some(r => r.toLowerCase() === add.toLowerCase())) {
            guildConfig.selectableRoles.push(add);
            feedback.push(`Added **${add}**`);
          }
        }
        if (remove) {
          const originalCount = guildConfig.selectableRoles.length;
          guildConfig.selectableRoles = guildConfig.selectableRoles.filter(r => r.toLowerCase() !== remove.toLowerCase());
          if (guildConfig.selectableRoles.length < originalCount) {
            feedback.push(`Removed **${remove}**`);
          }
        }
 
        saveConfig();
        return interaction.reply({ content: feedback.length > 0 ? `ARCUS Registry Updated: ${feedback.join(', ')}` : "No changes made to Registry.", flags: [MessageFlags.Ephemeral] });
      }
 
      if (customId === 'settings:modal:gen') {
        const guildConfig = getGuildConfig(interaction.guildId);
        const size = parseInt(interaction.fields.getTextInputValue('max_size'));
        const defRole = interaction.fields.getTextInputValue('def_role').trim();
 
        if (isNaN(size) || size < 1 || size > 10) return interaction.reply({ content: 'Invalid squad size. Please choose a number between 1 and 10.', flags: [MessageFlags.Ephemeral] });
 
        const available = guildConfig.selectableRoles;
        if (!available.some(r => r.toLowerCase() === defRole.toLowerCase())) {
          return interaction.reply({
            content: `⚠️ **Warning**: "${defRole}" is not in your Tactical Role list. Please add it to the registry first or check your spelling.`,
            flags: [MessageFlags.Ephemeral]
          });
        }
 
        guildConfig.maxSquadSize = size;
        guildConfig.defaultRole = defRole;
        saveConfig();
        return interaction.reply({ content: 'ARCUS: General settings updated.', flags: [MessageFlags.Ephemeral] });
      }
 
      if (parts[1] === 'modal' && parts[2] === 'aar') {
        const opId = parts[3];
        const op = getOpById(data, opId);
 
        if (!op) return interaction.reply({ content: 'ARCUS: Operation data lost.', flags: [MessageFlags.Ephemeral] });
 
        op.aar_phases = interaction.fields.getTextInputValue('aar_phases');
        op.aar_performance = interaction.fields.getTextInputValue('aar_performance');
 
        saveData(data);
        await updateOperationMessage(client, op);
 
        return interaction.reply({ content: `✅ **AAR Filed for Op ${op.name}**. The operation board has been updated.` });
      }
 
      if (parts[1] === 'modal' && parts[2] === 'submit') {
        const guildId = parts[3];
        const channelId = parts[4];
 
        const name = interaction.fields.getTextInputValue('op_name');
        const time = interaction.fields.getTextInputValue('op_time');
        const description = interaction.fields.getTextInputValue('op_description');
        const pingRaw = interaction.fields.getTextInputValue('op_pings') || '';
        const reminderMins = parseInt(interaction.fields.getTextInputValue('op_reminder')) || 0;
 
        if (!channelId || channelId === 'undefined') return interaction.reply({ content: 'ARCUS: Invalid channel configuration.', flags: [MessageFlags.Ephemeral] });
 
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.guild) return interaction.reply({ content: 'ARCUS: Target channel no longer exists.', flags: [MessageFlags.Ephemeral] });
        const guild = channel.guild;
 
        let pingString = '';
        if (pingRaw) {
          const roleTargets = pingRaw.split(',').map(s => s.trim());
          const mentions = [];
 
          for (const target of roleTargets) {
            const role = guild.roles.cache.find(r =>
              r.name.toLowerCase() === target.toLowerCase() || r.id === target
            );
            if (role) mentions.push(`<@&${role.id}>`);
            else mentions.push(target);
          }
          pingString = mentions.join(' ');
        }
 
        let scheduledEventId = null;
        const startTimeMs = parseOpTime(time);
        if (!isNaN(startTimeMs) && startTimeMs > Date.now()) {
          try {
            const scheduledEvent = await guild.scheduledEvents.create({
              name: `Op: ${name}`,
              description: description.substring(0, 1000),
              scheduledStartTime: new Date(startTimeMs),
              privacyLevel: 2,
              entityType: 3,
              entityMetadata: { location: `Channel: #${channel.name}` },
              reason: 'ARCUS Operation Created'
            });
            scheduledEventId = scheduledEvent.id;
          } catch (e) {
            console.error('ARCUS: Failed to create Scheduled Event:', e);
          }
        }
 
        const opId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const op = {
          id: opId,
          channelId: channelId,
          messageId: null,
          guildId: channel.guildId,
          creatorId: interaction.user.id,
          creatorTag: interaction.user.tag,
          name,
          time,
          description,
          scheduledEventId,
          reminderMinutes: reminderMins,
          reminderSent: false,
          locked: false,
          squads: [{ name: 'Alpha', members: [] }],
          participants: [],
          attendance: {}
        };
 
        const msg = await channel.send({ content: pingString, embeds: [buildOperationEmbed(op)], components: [buildActionRow(op)] });
        op.messageId = msg.id;
        data.operations[opId] = op;
        saveData(data);
        return interaction.reply({ content: `ARCUS: Operation **${name}** created in <#${channelId}>.`, flags: [MessageFlags.Ephemeral] });
      }
 
      if (parts[1] === 'modal' && parts[2] === 'prof_edit') {
        const targetUserId = parts[3];
        const ustats = ensureUserStats(data, targetUserId);
 
        const getVal = (id) => {
          try { return interaction.fields.getTextInputValue(id); } catch { return null; }
        };
 
        const bctVal = getVal('bct_status');
        if (bctVal !== null) ustats.passedBCT = (bctVal.toLowerCase() === 'yes' || bctVal.toLowerCase() === 'true');
 
        const attended = getVal('attended_ops');
        if (attended !== null) ustats.attended = parseInt(attended) || 0;
        const led = getVal('led_ops');
        if (led !== null) ustats.ledOps = parseInt(led) || 0;
        const recruits = getVal('recruit_count');
        if (recruits !== null) ustats.recruits = parseInt(recruits) || 0;
        const promNotes = getVal('prom_notes');
        if (promNotes !== null) ustats.promotionNotes = promNotes;
        const cNote = getVal('council_note');
        if (cNote !== null) ustats.councilNote = cNote;
 
        saveData(data);
        return interaction.reply({ content: `✅ Updated record for <@${targetUserId}>.`, flags: [MessageFlags.Ephemeral] });
      }
    }
  } catch (error) {
    console.error('ARCUS: Global Interaction Error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'ARCUS Internal Error: System failed to process interaction.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
  }
});
 
client.login(TOKEN);
 