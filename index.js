// ARCUS: Operations Management Bot
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
const fs   = require('fs-extra');
const path = require('path');

// ─── Environment Validation ───────────────────────────────────────────────────
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
  console.error('ARCUS Critical: TOKEN or CLIENT_ID is missing in environment variables.');
  process.exit(1);
}
const TOKEN     = process.env.TOKEN.trim();
const CLIENT_ID = process.env.CLIENT_ID.trim();

if (TOKEN.includes('your_bot_token_here') || TOKEN.length < 50) {
  console.error('ARCUS Critical: TOKEN appears invalid. Paste the actual Bot Token from the Discord Developer Portal.');
  process.exit(1);
}

// ─── Config & Data Persistence ───────────────────────────────────────────────
const configPath = path.resolve(__dirname, 'config.json');
const DATA_FILE  = path.join(__dirname, 'data.json');

const DEFAULT_GUILD_CONFIG = {
  authorizedRoles:       ['Admin'],
  eventCreatorRoles:     [],
  operationsChannelId:   '',
  maxSquadSize:          4,
  selectableRoles:       ['Point Man', 'Overwatch', 'Medic', 'Demolitions'],
  templates:             [],
  defaultRole:           'Point Man',
  commendations:         [],
  logsChannelId:         '',
  announcementChannelId: '',
  bctChannelId:          '',
  bctInstructorRoleId:   '',
  approvalChannelId:     '',
  requireOpApproval:     false
};

function createDefaultGuildConfig(guildId = '') {
  return {
    ...DEFAULT_GUILD_CONFIG,
    defaultGuildId:    guildId,
    authorizedRoles:   [...DEFAULT_GUILD_CONFIG.authorizedRoles],
    eventCreatorRoles: [...DEFAULT_GUILD_CONFIG.eventCreatorRoles],
    selectableRoles:   [...DEFAULT_GUILD_CONFIG.selectableRoles],
    templates:         [],
    commendations:     []
  };
}

function normalizeGuildConfig(guildConfig) {
  let changed = false;
  const defaults = createDefaultGuildConfig();
  for (const [key, value] of Object.entries(defaults)) {
    if (guildConfig[key] === undefined) { guildConfig[key] = value; changed = true; }
  }
  for (const key of ['authorizedRoles', 'eventCreatorRoles', 'selectableRoles', 'templates', 'commendations']) {
    if (!Array.isArray(guildConfig[key])) { guildConfig[key] = defaults[key]; changed = true; }
  }
  return changed;
}

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) fs.writeJsonSync(configPath, { guilds: {} }, { spaces: 2 });
    const cfg = fs.readJsonSync(configPath);
    let changed = false;
    if (!cfg.guilds) { cfg.guilds = {}; changed = true; }
    for (const [guildId, guildConfig] of Object.entries(cfg.guilds)) {
      if (!guildConfig.defaultGuildId) { guildConfig.defaultGuildId = guildId; changed = true; }
      if (normalizeGuildConfig(guildConfig)) changed = true;
    }
    if (changed) fs.writeJsonSync(configPath, cfg, { spaces: 2 });
    return cfg;
  } catch (err) {
    console.warn(`ARCUS: Config loading failed (${err.code}). Initializing empty config.`);
    return { guilds: {} };
  }
}
let config = loadConfig();

// FIX #7: reload config from disk before each save so external edits aren't overwritten
function saveConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const fresh = fs.readJsonSync(configPath);
      // Merge our in-memory guild configs onto the freshly read file
      for (const [guildId, guildCfg] of Object.entries(config.guilds || {})) {
        fresh.guilds[guildId] = guildCfg;
      }
      fs.writeJsonSync(configPath, fresh, { spaces: 2 });
      config = fresh;
    } else {
      fs.writeJsonSync(configPath, config, { spaces: 2 });
    }
  } catch (err) {
    console.error('ARCUS: saveConfig failed:', err.message);
  }
}

function getGuildConfig(guildId) {
  if (!guildId) return {};
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = createDefaultGuildConfig(guildId);
    saveConfig();
  } else if (normalizeGuildConfig(config.guilds[guildId])) {
    saveConfig();
  } else if (!config.guilds[guildId].defaultGuildId) {
    config.guilds[guildId].defaultGuildId = guildId;
    saveConfig();
  }
  return config.guilds[guildId];
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeJsonSync(DATA_FILE, { operations: {}, users: {}, pendingOps: {} }, { spaces: 2 });
    }
    const data = fs.readJsonSync(DATA_FILE);
    data.operations ??= {};
    data.users      ??= {};
    data.pendingOps ??= {};
    return data;
  } catch (err) {
    console.warn(`ARCUS: Data loading failed (${err.code}). Initializing empty state.`);
    return { operations: {}, users: {}, pendingOps: {} };
  }
}
function saveData(data) { fs.writeJsonSync(DATA_FILE, data, { spaces: 2 }); }

// ─── Auth Helpers ─────────────────────────────────────────────────────────────
function isAuthorized(member, guildId) {
  if (!member?.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const authRoles = getGuildConfig(guildId).authorizedRoles || [];
  return member.roles.cache.some(role =>
    authRoles.some(auth => auth.toLowerCase() === role.name.toLowerCase() || auth === role.id)
  );
}

function canCreateEvent(member, guildId) {
  if (!member?.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const gc = getGuildConfig(guildId);
  return isAuthorized(member, guildId) ||
    member.roles.cache.some(role => (gc.eventCreatorRoles || []).includes(role.id));
}
const canCreateSquad = canCreateEvent;

// ─── Time Parsing ─────────────────────────────────────────────────────────────
function parseOpTime(timeStr) {
  if (!timeStr) return NaN;
  const now  = new Date();
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const parts = timeStr.toLowerCase().trim().split(/\s+/);
  const dayIndex = parts.findIndex(p => days.includes(p));
  const timePart = parts.find(p => p.includes(':') || p.endsWith('am') || p.endsWith('pm'));

  if (dayIndex !== -1 && timePart) {
    const targetDay = days.indexOf(parts[dayIndex]);
    const date = new Date();
    const diff = (targetDay + 7 - now.getDay()) % 7;
    date.setDate(now.getDate() + diff);

    let hours = 0, minutes = 0;
    if (timePart.includes(':')) {
      const t = timePart.split(':');
      hours   = parseInt(t[0]);
      minutes = parseInt(t[1]);
    } else {
      hours = parseInt(timePart);
    }
    if (timePart.includes('pm') && hours < 12) hours += 12;
    if (timePart.includes('am') && hours === 12) hours = 0;

    date.setHours(hours, minutes, 0, 0);
    if (date < now) date.setDate(date.getDate() + 7);
    return date.getTime();
  }
  return Date.parse(timeStr);
}

// ─── Operation Helpers ────────────────────────────────────────────────────────
const squadNames = ['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Gamma','Hotel','India'];

function generateOpId(data) {
  let id;
  do { id = Math.random().toString(36).substring(2, 8).toUpperCase().padEnd(6, '0'); }
  while (data.operations[id]);
  return id;
}

function normalizeOpId(opId) { return String(opId || '').trim().toLowerCase(); }

function getOpLookupIds(key, op) {
  const ids = [key, op?.id];
  for (const id of [...ids]) {
    const suffix = String(id || '').split('_').pop();
    if (suffix && suffix !== id) ids.push(suffix);
  }
  return ids.map(normalizeOpId).filter(Boolean);
}

function findOpEntryById(data, opId, guildId = null) {
  const wanted = normalizeOpId(opId);
  if (!wanted || !data?.operations) return null;
  for (const [key, op] of Object.entries(data.operations)) {
    if (guildId && op?.guildId !== guildId) continue;
    if (getOpLookupIds(key, op).includes(wanted)) return { key, op };
  }
  return null;
}

function getOpById(data, opId, guildId = null) {
  return findOpEntryById(data, opId, guildId)?.op || null;
}

function getActiveOpsForGuild(data, guildId) {
  return Object.values(data.operations || {}).filter(op => op.guildId === guildId && !op.locked);
}

function findUserSquad(op, userId) {
  return op.squads.find(s => s.members.some(m => m.userId === userId));
}

function getNextSquadName(op) {
  const existing = op.squads.map(s => s.name);
  return squadNames.find(n => !existing.includes(n)) || null;
}

function formatSquadListing(op, guildId) {
  const gc = getGuildConfig(guildId);
  return op.squads.map(squad => {
    const members = (squad.members || [])
      .map(m => `• ${m.username} (${m.role || gc.defaultRole})`)
      .join('\n') || '_Empty_';
    return `**${squad.name}**\n${members}`;
  }).join('\n\n') || '_No squads_';
}

function buildOperationEmbed(op) {
  const startTime   = parseOpTime(op.time);
  const timeDisplay = isNaN(startTime)
    ? op.time
    : `<t:${Math.floor(startTime / 1000)}:F> (<t:${Math.floor(startTime / 1000)}:R>)`;

  const embed = new EmbedBuilder()
    .setTitle(`ARCUS: Operation ${op.name}`)
    .setDescription(`**Status:** ${op.locked ? '🔒 Locked' : '✅ Active'}`)
    .addFields(
      { name: '⏱️ Operational Time', value: timeDisplay, inline: false },
      { name: '📋 Briefing',         value: op.description || 'N/A' }
    );

  if (op.aar_phases)      embed.addFields({ name: '📝 AAR: Mission Summary',  value: op.aar_phases });
  if (op.aar_performance) embed.addFields({ name: '⭐ Personnel Evaluation', value: op.aar_performance });

  embed.addFields({ name: '👥 Squads', value: formatSquadListing(op, op.guildId) });
  if (op.mapUrl) embed.setImage(op.mapUrl);
  if (op.readyUsers?.length) {
    embed.addFields({ name: 'Ready Check', value: `${op.readyUsers.length} ready`, inline: true });
  }

  // FIX #5: user.tag is deprecated in discord.js v14 — use username instead
  return embed.setFooter({ text: `Tactical ID: ${op.id} | Creator: ${op.creatorTag}` });
}

function buildActionRow(op) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`op:join:${op.id}`).setLabel('Join').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:leave:${op.id}`).setLabel('Leave').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:role:${op.id}`).setLabel('Role').setEmoji('🎯').setStyle(ButtonStyle.Primary).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:squad:${op.id}`).setLabel('New Squad').setEmoji('➕').setStyle(ButtonStyle.Secondary).setDisabled(op.locked),
    new ButtonBuilder().setCustomId(`op:ready:${op.id}`).setLabel('Ready').setEmoji('🟢').setStyle(ButtonStyle.Secondary).setDisabled(op.locked)
  );
}

async function updateOperationMessage(client, op) {
  try {
    const channel = await client.channels.fetch(op.channelId);
    const message = await channel.messages.fetch(op.messageId);
    await message.edit({ embeds: [buildOperationEmbed(op)], components: [buildActionRow(op)] });
  } catch (err) {
    console.error('Failed to update operation message:', err);
  }
}

async function createBctTrainingOperation(client, interaction, recruitId, time, description) {
  const guild     = interaction.guild;
  const gc        = getGuildConfig(guild.id);
  const channelId = gc.operationsChannelId || interaction.channelId;
  const channel   = await client.channels.fetch(channelId);
  if (!channel?.guild) throw new Error('Target operations channel not found.');

  const data       = loadData();
  const recruit    = await client.users.fetch(recruitId);
  const instructor = interaction.user;

  let scheduledEventId = null;
  const startTimeMs    = parseOpTime(time);
  if (!isNaN(startTimeMs) && startTimeMs > Date.now()) {
    try {
      const ev = await guild.scheduledEvents.create({
        name: `BCT: ${recruit.username}`,
        description: description.substring(0, 1000),
        scheduledStartTime: new Date(startTimeMs),
        privacyLevel: 2,
        entityType: 3,
        entityMetadata: { location: `#${channel.name}` },
        reason: 'ARCUS BCT Training Created'
      });
      scheduledEventId = ev.id;
    } catch (e) { console.error('ARCUS: BCT scheduled event creation failed:', e); }
  }

  const opId = generateOpId(data);
  const op = {
    id:                 opId,
    type:               'bct',
    bctRecruitId:       recruitId,
    channelId,
    messageId:          null,
    guildId:            guild.id,
    creatorId:          instructor.id,
    // FIX #5: use username instead of deprecated .tag
    creatorTag:         instructor.username,
    name:               `BCT - ${recruit.username}`,
    time,
    description,
    mapUrl:             null,
    scheduledEventId,
    reminderMinutes:    [],
    remindersSent:      [],
    locked:             false,
    attendanceRecorded: false,
    selectableRoles:    gc.selectableRoles,
    squads: [{
      name: 'Alpha',
      members: [
        { userId: instructor.id, username: instructor.username, role: 'Squad Lead' },
        { userId: recruit.id,    username: recruit.username,    role: gc.defaultRole || 'Recruit' }
      ]
    }],
    participants: [
      { userId: instructor.id, username: instructor.username },
      { userId: recruit.id,    username: recruit.username }
    ],
    attendance: {}
  };

  const msg = await channel.send({
    content: `<@${recruitId}>`,
    embeds: [buildOperationEmbed(op)],
    components: [buildActionRow(op)]
  });
  op.messageId = msg.id;
  data.operations[opId] = op;
  saveData(data);
  return op;
}

// ─── Rank Structure ───────────────────────────────────────────────────────────
const ranks = [
  { name: 'Recruit',          minAttended: 0 },
  { name: 'Sergeant',         minAttended: 3,  requireBCT: true },
  { name: 'Lieutenant',       minAttended: 6,  minRecruits: 2 },
  { name: 'Captain',          minAttended: 10, minLed: 3, minRecruits: 4 },
  { name: 'Council',          minAttended: 0,  appointed: true },
  { name: 'Council Chief',    minAttended: 0,  appointed: true },
  { name: 'Deputy Commander', minAttended: 0,  appointed: true },
  { name: 'Commander',        minAttended: 0,  appointed: true }
];

function getRank(member, stats) {
  if (member?.roles) {
    for (let i = ranks.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase().trim() === ranks[i].name.toLowerCase().trim()))
        return ranks[i];
    }
  }
  return ranks[0];
}

// ─── User Stats ───────────────────────────────────────────────────────────────
function ensureUserStats(data, userId) {
  if (!data.users[userId]) data.users[userId] = {};
  const u = data.users[userId];
  u.joined           ??= 0;
  u.attended         ??= 0;
  u.medals           ??= [];
  u.passedBCT        ??= false;
  u.promotionNotes   ??= '';
  u.ledOps           ??= 0;
  u.recruits         ??= 0;
  u.councilNote      ??= '';
  u.availability     ??= 'unknown';
  u.availabilityNote ??= '';
  return u;
}

function formatOperationTime(op) {
  const startTime = parseOpTime(op.time);
  return isNaN(startTime) ? op.time : `<t:${Math.floor(startTime / 1000)}:F>`;
}

function getOperationIdDisplay(opKey, op) { return op?.id || opKey; }

async function sendOperationReminder(client, op, message = '') {
  const targets = new Map();
  for (const p of (op.participants || [])) targets.set(p.userId, p.username);
  for (const squad of (op.squads || [])) {
    for (const member of (squad.members || [])) targets.set(member.userId, member.username);
  }
  let sent = 0;
  for (const [userId] of targets) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`🔔 **ARCUS Reminder**: Operation **${op.name}** is scheduled for ${formatOperationTime(op)}.${message ? `\n${message}` : ''}`);
      sent += 1;
    } catch { }
  }
  return sent;
}

async function createOperationFromDraft(client, draft) {
  const channel = await client.channels.fetch(draft.channelId);
  if (!channel?.guild) throw new Error('Target channel not found.');

  const guild = channel.guild;
  const gc    = getGuildConfig(draft.guildId);
  const data  = loadData();

  let pingString = '';
  if (draft.pingRaw) {
    pingString = draft.pingRaw.split(',').map(s => s.trim()).filter(Boolean).map(target => {
      const role = guild.roles.cache.find(r => r.name.toLowerCase() === target.toLowerCase() || r.id === target);
      return role ? `<@&${role.id}>` : target;
    }).join(' ');
  }

  let scheduledEventId = null;
  const startTimeMs    = parseOpTime(draft.time);
  if (!isNaN(startTimeMs) && startTimeMs > Date.now()) {
    try {
      const ev = await guild.scheduledEvents.create({
        name: `Op: ${draft.name}`,
        description: draft.description.substring(0, 1000),
        scheduledStartTime: new Date(startTimeMs),
        privacyLevel: 2,
        entityType: 3,
        entityMetadata: { location: `#${channel.name}` },
        reason: 'ARCUS Operation Created'
      });
      scheduledEventId = ev.id;
    } catch (e) { console.error('ARCUS: Scheduled event creation failed:', e); }
  }

  const opId = generateOpId(data);
  const op = {
    id:                 opId,
    channelId:          draft.channelId,
    messageId:          null,
    guildId:            draft.guildId,
    creatorId:          draft.creatorId,
    creatorTag:         draft.creatorTag,
    name:               draft.name,
    time:               draft.time,
    description:        draft.description,
    mapUrl:             draft.mapUrl || null,
    scheduledEventId,
    reminderMinutes:    draft.reminderMinutes || [],
    remindersSent:      [],
    locked:             false,
    attendanceRecorded: false,
    aarRequired:        false,
    aarSubmitted:       false,
    selectableRoles:    gc.selectableRoles,
    squads:             [{ name: 'Alpha', members: [] }],
    participants:       [],
    attendance:         {}
  };

  const msg = await channel.send({ content: pingString || undefined, embeds: [buildOperationEmbed(op)], components: [buildActionRow(op)] });
  op.messageId = msg.id;
  data.operations[opId] = op;
  saveData(data);
  return op;
}

function buildReadySummary(op) {
  const ready = Array.isArray(op.readyUsers) ? op.readyUsers : [];
  return ready.length ? ready.map(id => `<@${id}>`).join('\n') : '_No operators ready yet._';
}

// ─── Discord Client ───────────────────────────────────────────────────────────
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

// ─── Settings Embed ───────────────────────────────────────────────────────────
function buildSettingsEmbed(guildConfig, section = 'main') {
  const data      = loadData();
  const activeOps = getActiveOpsForGuild(data, guildConfig.defaultGuildId).length;
  const embed     = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

  if (section === 'main') {
    embed
      .setTitle('🛡️ ARCUS COMMAND | Master Control')
      .setDescription('System Core Status & Configuration\n\nUse the buttons below to navigate modules.')
      .addFields(
        { name: '📡 Operations Channel', value: guildConfig.operationsChannelId ? `<#${guildConfig.operationsChannelId}>` : '`Not Configured`', inline: true },
        { name: '👥 Max Squad Size',     value: `\`${guildConfig.maxSquadSize || 4}\``, inline: true },
        { name: '🎯 Default Role',       value: `\`${guildConfig.defaultRole || 'Point Man'}\``, inline: true },
        { name: '📂 Templates',          value: `\`${(guildConfig.templates || []).length}\``, inline: true },
        { name: '📊 System Metrics',     value: `Ping: \`${client.ws.ping}ms\`\nUptime: \`${Math.floor(client.uptime / 3600000)}h ${Math.floor((client.uptime % 3600000) / 60000)}m\`\nActive Ops: \`${activeOps}\`` }
      )
      .setFooter({ text: 'ARCUS v1.0.0 • All systems operational' });
  } else if (section === 'gen') {
    embed.setTitle('⚙️ General Configuration').addFields(
      { name: '🛡️ Default Role',   value: `\`${guildConfig.defaultRole}\``, inline: true },
      { name: '📏 Max Squad Size', value: `\`${guildConfig.maxSquadSize}\``, inline: true },
      { name: '📍 Ops Channel',    value: guildConfig.operationsChannelId ? `<#${guildConfig.operationsChannelId}>` : '`Not Set`' }
    );
  } else if (section === 'perms') {
    embed.setTitle('🛡️ Permissions Registry').addFields(
      { name: 'Admin Roles',   value: (guildConfig.authorizedRoles   || []).map(r => `<@&${r}>`).join('\n') || '_None_', inline: true },
      { name: 'Creator Roles', value: (guildConfig.eventCreatorRoles || []).map(r => `<@&${r}>`).join('\n') || '_None_', inline: true }
    );
  } else if (section === 'roles') {
    const roles = (guildConfig.selectableRoles || []).map(r => `• **${r}**`).join('\n') || '> _None_';
    embed.setTitle('🎯 Tactical Role Registry').setDescription('Operational roles available:\n\n' + roles);
  } else if (section === 'templates') {
    embed.setTitle('📂 Mission Templates')
      .setDescription(`Saved Templates: \`${(guildConfig.templates || []).length}\``)
      .addFields({ name: 'Usage', value: 'Templates enable rapid operation deployment via `/op create`.' });
  }
  return embed;
}

// ─── Safe Modal Field Reader ──────────────────────────────────────────────────
function safeGetField(interaction, fieldId) {
  try { return interaction.fields.getTextInputValue(fieldId) || null; }
  catch { return null; }
}

// ─── Build Slash Commands ─────────────────────────────────────────────────────
function buildCommandData() {
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
    .addSubcommand(s => s.setName('aar').setDescription('File an After Action Report')
      .addStringOption(o => o.setName('id').setDescription('Operation ID').setRequired(true)))
    .addSubcommand(s => s.setName('profile').setDescription('View an operator service record')
      .addUserOption(o => o.setName('target').setDescription('User to view')))
    .addSubcommand(s => s.setName('award').setDescription('Admin: Award a medal')
      .addUserOption(o => o.setName('target').setDescription('Operator').setRequired(true))
      .addStringOption(o => o.setName('medal').setDescription('Medal name').setRequired(true).setAutocomplete(true)))
    // FIX #1 & #4: /op revoke subcommand was missing from buildCommandData() and had no handler
    .addSubcommand(s => s.setName('revoke').setDescription('Admin: Revoke a medal')
      .addUserOption(o => o.setName('target').setDescription('Operator').setRequired(true))
      .addStringOption(o => o.setName('medal').setDescription('Medal name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('leaderboard').setDescription('View top operators'))
    .addSubcommand(s => s.setName('motm').setDescription('Show member of the month'))
    .addSubcommand(s => s.setName('clear_stats').setDescription('Admin: Wipe all attendance statistics'));
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`ARCUS ready: ${client.user.tag}`);
  client.user.setActivity('Operational Logs', { type: ActivityType.Watching });

  const rest        = new REST({ version: '10' }).setToken(TOKEN);
  const commandJSON = buildCommandData().toJSON();

  try {
    console.log('ARCUS: Registering slash commands globally...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [commandJSON] });
    console.log('ARCUS: Global slash commands registered successfully.');

    const guilds = client.guilds.cache.map(g => g.id);
    console.log(`ARCUS: Found ${guilds.length} guild(s). Syncing per-guild commands...`);
    for (const gId of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gId), { body: [commandJSON] });
        console.log(`ARCUS: Commands synced to guild ${gId}`);
      } catch (err) {
        console.error(`ARCUS: Failed to sync commands to guild ${gId}:`, err.message);
      }
    }
    console.log('ARCUS: Command sync complete.');
  } catch (error) {
    console.error('ARCUS: Command registration failed:', error);
  }

  // ─── Reminder loop ─────────────────────────────────────────────────────────
  setInterval(async () => {
    const data  = loadData();
    let changed = false;
    const now   = Date.now();

    for (const opId in data.operations) {
      const op = data.operations[opId];
      if (op.locked) continue;
      const startTime = parseOpTime(op.time);
      if (!startTime || isNaN(startTime)) continue;

      const thresholds = Array.isArray(op.reminderMinutes) ? op.reminderMinutes : (op.reminderMinutes ? [op.reminderMinutes] : []);
      if (!thresholds.length) continue;
      if (!Array.isArray(op.remindersSent)) op.remindersSent = [];

      for (const mins of thresholds) {
        if (op.remindersSent.includes(mins)) continue;
        if (now >= startTime - mins * 60000) {
          for (const p of (op.participants || [])) {
            try {
              const user = await client.users.fetch(p.userId);
              await user.send(`🔔 **ARCUS Reminder**: Operation **${op.name}** starts in ~**${mins} minute${mins !== 1 ? 's' : ''}**!`);
            } catch { }
          }
          op.remindersSent.push(mins);
          changed = true;
        }
      }
      if (op.reminderSent !== undefined) { delete op.reminderSent; changed = true; }
      data.operations[opId] = op;
    }
    if (changed) saveData(data);
  }, 60000);
});

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  let isDeferred = false;

  try {
    // ─── Autocomplete Handler ──────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const gc = getGuildConfig(interaction.guildId);
      const focusedValue = interaction.options.getFocused();
      const choices = (gc.commendations || []).map(c => c.name);
      const filtered = choices
        .filter(choice => choice.toLowerCase().includes(focusedValue.toLowerCase()))
        .slice(0, 25);
      return await interaction.respond(filtered.map(choice => ({ name: choice, value: choice })));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SLASH COMMANDS
    // ══════════════════════════════════════════════════════════════════════════
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'op') return;

      const sub   = interaction.options.getSubcommand(false);
      const group = interaction.options.getSubcommandGroup(false);
      const data  = loadData();

      // ── /op create ─────────────────────────────────────────────────────────
      if (sub === 'create') {
        if (!canCreateEvent(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized. Creator permissions required.', flags: [MessageFlags.Ephemeral] });

        const gc              = getGuildConfig(interaction.guildId);
        const targetChannelId = gc.operationsChannelId || interaction.channelId;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`op:setup:${interaction.guildId}:${targetChannelId}`).setLabel('📝 Setup Operation').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`op:template_list:${interaction.guildId}:${targetChannelId}`).setLabel('📂 Use Template').setStyle(ButtonStyle.Secondary).setDisabled(!(gc.templates?.length > 0))
        );

        try {
          await interaction.user.send({
            embeds: [new EmbedBuilder().setTitle('ARCUS: Operation Creation').setDescription(`Creating op for <#${targetChannelId}>. Click below to configure.`).setColor(0xed4245)],
            components: [row]
          });
          return interaction.reply({ content: 'ARCUS: Setup menu sent to your DMs.', flags: [MessageFlags.Ephemeral] });
        } catch {
          return interaction.reply({ content: 'ARCUS: Could not DM you. Enable DMs and try again.', flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op end ────────────────────────────────────────────────────────────
      if (sub === 'end') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });

        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;
        if (op.locked) return interaction.reply({ content: 'ARCUS: Operation already ended.', flags: [MessageFlags.Ephemeral] });

        op.locked       = true;
        op.endedAt      = new Date().toISOString();
        op.aarRequired  = true;
        op.aarSubmitted = Boolean(op.aar_phases);
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);

        try {
          const opChannel = await client.channels.fetch(op.channelId);
          const aarMsg = await opChannel.send({
            embeds: [new EmbedBuilder()
              .setTitle('ARCUS: AAR Required')
              .setDescription(`Operation **${op.name}** has ended. The creator should submit an After Action Report.`)
              .addFields({ name: 'Operation ID', value: `\`${op.id}\``, inline: true })
              .setColor(0xFFA500)
              .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`op:aar_trigger:${opKey}`).setLabel('File AAR').setStyle(ButtonStyle.Primary)
            )]
          });
          op.aarRequestMessageId = aarMsg.id;
          data.operations[opKey] = op;
          saveData(data);
        } catch { }

        if (op.scheduledEventId) {
          try {
            const guild = await client.guilds.fetch(op.guildId);
            await guild.scheduledEvents.delete(op.scheduledEventId);
          } catch { }
        }

        try {
          const dm      = await interaction.user.createDM();
          const options = (op.participants || []).map(u => ({ label: u.username || 'Unknown', value: u.userId }));
          if (!options.length) {
            await dm.send('ARCUS: Operation ended — no participants to mark attendance for.');
          } else {
            const menuRow = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId(`op:attendance:${opKey}`).setPlaceholder('Select attendees').setMinValues(0).setMaxValues(options.length).addOptions(options)
            );
            const aarRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`op:aar_trigger:${opKey}`).setLabel('📝 File AAR').setStyle(ButtonStyle.Primary)
            );
            const dmComponents = [menuRow, aarRow];
            if (op.type === 'bct' && op.bctRecruitId) {
              dmComponents.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`op:bct_complete:${opKey}:${op.bctRecruitId}`).setLabel('Mark BCT Passed').setStyle(ButtonStyle.Success)
              ));
            }
            await dm.send({ content: 'ARCUS: Mark attendance, then file the AAR.', components: dmComponents });
          }
          return interaction.reply({ content: 'ARCUS: Operation locked. Attendance DM sent.', flags: [MessageFlags.Ephemeral] });
        } catch {
          return interaction.reply({ content: 'ARCUS: Operation locked, but DM failed. Check DM settings.', flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op delete ─────────────────────────────────────────────────────────
      if (sub === 'delete') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;

        try {
          const ch  = await client.channels.fetch(op.channelId);
          const msg = await ch.messages.fetch(op.messageId);
          await msg.delete();
        } catch { }

        if (op.scheduledEventId) {
          try { const guild = await client.guilds.fetch(op.guildId); await guild.scheduledEvents.delete(op.scheduledEventId); } catch { }
        }

        delete data.operations[opKey];
        saveData(data);
        return interaction.reply({ content: `ARCUS: Operation **${op.name}** deleted.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op admin ──────────────────────────────────────────────────────────
      if (group === 'admin') {
        if (!interaction.member.permissions.has('Administrator') && !isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Administrator required.', flags: [MessageFlags.Ephemeral] });

        const gc   = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
        if (sub === 'grant') {
          if (!gc.authorizedRoles.includes(role.id)) gc.authorizedRoles.push(role.id);
        } else {
          gc.authorizedRoles = gc.authorizedRoles.filter(id => id !== role.id);
        }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Admin list updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op creator ────────────────────────────────────────────────────────
      if (group === 'creator') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });

        const gc   = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
        if (sub === 'grant') {
          if (!gc.eventCreatorRoles.includes(role.id)) gc.eventCreatorRoles.push(role.id);
        } else {
          gc.eventCreatorRoles = gc.eventCreatorRoles.filter(id => id !== role.id);
        }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Creator permissions updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op tactical ───────────────────────────────────────────────────────
      if (group === 'tactical') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });

        const gc       = getGuildConfig(interaction.guildId);
        const roleName = interaction.options.getString('name');

        if (sub === 'add') {
          if (!gc.selectableRoles.includes(roleName)) gc.selectableRoles.push(roleName);
          saveConfig();
          return interaction.reply({ content: `ARCUS: **${roleName}** added to Tactical Registry.`, flags: [MessageFlags.Ephemeral] });
        }
        if (sub === 'remove') {
          gc.selectableRoles = gc.selectableRoles.filter(r => r !== roleName);
          saveConfig();
          return interaction.reply({ content: `ARCUS: **${roleName}** removed from Tactical Registry.`, flags: [MessageFlags.Ephemeral] });
        }
        return interaction.reply({ content: `**Tactical Registry:**\n${gc.selectableRoles.map(r => `• ${r}`).join('\n') || '_None_'}`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op template ───────────────────────────────────────────────────────
      if (group === 'template') {
        const gc = getGuildConfig(interaction.guildId);

        if (sub === 'add' || sub === 'suggest') {
          if (sub === 'add' && !isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          if (!canCreateEvent(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Unauthorized. Creator permissions required.', flags: [MessageFlags.Ephemeral] });

          const modal = new ModalBuilder()
            .setCustomId(sub === 'add' ? 'op:template:add_modal' : 'op:template:suggest_modal')
            .setTitle(sub === 'add' ? 'Create Mission Template' : 'Suggest Mission Template');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_name').setLabel('Template Name').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_desc').setLabel('Default Briefing').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_pings').setLabel('Default Pings (Roles)').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_reminder').setLabel('Reminder (mins)').setStyle(TextInputStyle.Short).setValue('30'))
          );
          return interaction.showModal(modal);
        }

        if (sub === 'remove') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const idx = interaction.options.getInteger('index');
          if (gc.templates?.[idx]) {
            const [removed] = gc.templates.splice(idx, 1);
            saveConfig();
            return interaction.reply({ content: `ARCUS: Template **${removed.name}** deleted.`, flags: [MessageFlags.Ephemeral] });
          }
          return interaction.reply({ content: 'ARCUS: Invalid template index.', flags: [MessageFlags.Ephemeral] });
        }

        const list = (gc.templates || []).map((t, i) => `\`[${i}]\` **${t.name}**: ${t.description.substring(0, 40)}...`).join('\n') || '_No templates._';
        return interaction.reply({ content: `**Mission Templates:**\n${list}`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op commendation ───────────────────────────────────────────────────
      if (group === 'commendation') {
        const gc = getGuildConfig(interaction.guildId);

        if (sub === 'add') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

          const modal = new ModalBuilder()
            .setCustomId('op:modal:commendation:add')
            .setTitle('Add Commendation to Registry');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_name').setLabel('Medal Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Medal of Valor')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_desc').setLabel('Description / Purpose').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Awarded for exceptional courage...')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_reqs').setLabel('Requirements').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Requires 10 successful deployments...')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_emoji').setLabel('Emoji / Icon').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 🎖️')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_image').setLabel('Ribbon Image URL (Optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('https://...'))
          );
          return interaction.showModal(modal);
        }
        if (sub === 'remove') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const name = interaction.options.getString('name');
          gc.commendations = gc.commendations.filter(c => c.name.toLowerCase() !== name.toLowerCase());
          saveConfig();
          return interaction.reply({ content: `ARCUS: Commendation **${name}** removed.` });
        }

        const list = gc.commendations.map(c => {
          const emoji = c.emoji ? `${c.emoji} ` : '';
          return `### ${emoji}${c.name}\n**Purpose:** ${c.description}\n**Criteria:** ${c.requirements}`;
        }).join('\n\n');
        if (!list) return interaction.reply({ content: 'ARCUS: Commendation registry is empty.', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder()
          .setTitle('🎖️ ARCUS Commendation Registry')
          .setDescription(list)
          .setColor(0xFFD700)
          .setFooter({ text: 'Use /op award to recognize an operator' });
        return interaction.reply({ embeds: [embed] });
      }

      // ── /op bct request ────────────────────────────────────────────────────
      if (group === 'bct') {
        if (sub !== 'request') return;
        const gc = getGuildConfig(interaction.guildId);
        if (!gc.bctChannelId)
          return interaction.reply({ content: 'ARCUS: BCT request channel is not configured. Ask command to run `/op set_bct_channel`.', flags: [MessageFlags.Ephemeral] });
        if (!gc.bctInstructorRoleId)
          return interaction.reply({ content: 'ARCUS: BCT instructor role is not configured. Ask command to run `/op set_bct_role`.', flags: [MessageFlags.Ephemeral] });

        const stats = ensureUserStats(data, interaction.user.id);
        if (stats.passedBCT)
          return interaction.reply({ content: 'ARCUS: Your profile already shows BCT as passed.', flags: [MessageFlags.Ephemeral] });

        const ch = await interaction.guild.channels.fetch(gc.bctChannelId).catch(() => null);
        if (!ch) return interaction.reply({ content: 'ARCUS: BCT request channel not found.', flags: [MessageFlags.Ephemeral] });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`op:bct_accept:${interaction.guildId}:${interaction.user.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`op:bct_deny:${interaction.guildId}:${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );
        await ch.send({
          content: `<@&${gc.bctInstructorRoleId}>`,
          embeds: [new EmbedBuilder()
            .setTitle('ARCUS: BCT Request')
            .setDescription(`<@${interaction.user.id}> is requesting Basic Combat Training.`)
            .addFields(
              { name: 'Recruit', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Status',  value: 'Pending instructor acceptance', inline: true }
            )
            .setColor(0x5865f2)
            .setTimestamp()],
          components: [row]
        });
        return interaction.reply({ content: 'ARCUS: BCT request submitted.', flags: [MessageFlags.Ephemeral] });
      }

      // ── /op manage ─────────────────────────────────────────────────────────
      if (group === 'manage') {
        if (sub === 'list') {
          const entries = Object.entries(data.operations || {})
            .filter(([, op]) => op.guildId === interaction.guildId && !op.locked)
            .sort(([, a], [, b]) => (parseOpTime(a.time) || 0) - (parseOpTime(b.time) || 0));

          if (!entries.length)
            return interaction.reply({ content: 'ARCUS: No active operations for this server.', flags: [MessageFlags.Ephemeral] });

          const lines = entries.map(([key, op]) =>
            `\`${getOperationIdDisplay(key, op)}\` **${op.name}** - ${formatOperationTime(op)} - ${op.participants?.length || 0} signed`
          );
          return interaction.reply({
            embeds: [new EmbedBuilder().setTitle('ARCUS: Active Operations').setDescription(lines.join('\n')).setColor(0x5865f2)],
            flags: [MessageFlags.Ephemeral]
          });
        }

        if (sub === 'remind') {
          const opId    = interaction.options.getString('id');
          const opEntry = findOpEntryById(data, opId, interaction.guildId);
          if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
          const { op } = opEntry;
          if (interaction.user.id !== op.creatorId && !isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Only the creator or command can send reminders.', flags: [MessageFlags.Ephemeral] });

          await interaction.deferReply({ ephemeral: true });
          isDeferred = true;
          const sent = await sendOperationReminder(client, op, interaction.options.getString('message') || '');
          return interaction.editReply({ content: `ARCUS: Reminder sent to ${sent} operator${sent === 1 ? '' : 's'}.` });
        }

        if (sub === 'transfer') {
          const opId    = interaction.options.getString('id');
          const target  = interaction.options.getUser('target');
          const opEntry = findOpEntryById(data, opId, interaction.guildId);
          if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
          const { key: opKey, op } = opEntry;
          if (interaction.user.id !== op.creatorId && !isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Only the creator or command can transfer this operation.', flags: [MessageFlags.Ephemeral] });

          op.creatorId  = target.id;
          // FIX #5: use username instead of deprecated .tag
          op.creatorTag = target.username;
          data.operations[opKey] = op;
          saveData(data);
          await updateOperationMessage(client, op);
          return interaction.reply({ content: `ARCUS: Operation **${op.name}** transferred to <@${target.id}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'activity') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

          await interaction.deferReply({ ephemeral: true });
          isDeferred = true;

          const gc         = getGuildConfig(interaction.guildId);
          const members    = await interaction.guild.members.fetch().catch(() => null);
          const userEntries = Object.entries(data.users || {});
          const active = userEntries
            .filter(([, stats]) => (stats.attended || 0) > 0)
            .sort((a, b) => (b[1].attended || 0) - (a[1].attended || 0))
            .slice(0, 15);

          const inactive = members
            ? members.filter(member => !member.user.bot)
                .map(member => ({ member, stats: ensureUserStats(data, member.id) }))
                .filter(entry => !entry.stats.lastAttendedAt)
                .slice(0, 12)
            : [];

          const activeText = active.length
            ? active.map(([id, stats]) =>
                `<@${id}> - \`${stats.attended || 0}\` attended - last: ${stats.lastAttendedAt ? `<t:${Math.floor(new Date(stats.lastAttendedAt).getTime() / 1000)}:R>` : 'unknown'}`
              ).join('\n')
            : '_No attendance recorded._';
          const inactiveText = inactive.length
            ? inactive.map(({ member }) => `<@${member.id}>`).join('\n')
            : '_No inactive members found, or member cache unavailable._';

          const reportEmbed = new EmbedBuilder()
            .setTitle('📊 ARCUS: Tactical Activity Report')
            .setDescription(`Generated by <@${interaction.user.id}>`)
            .addFields(
              { name: '🔥 Most Active Personnel', value: activeText },
              { name: '🧊 Inactive (No Ops Recorded)', value: inactiveText }
            )
            .setColor(0x5865f2)
            .setTimestamp();

          if (gc.logsChannelId) {
            const logCh = await interaction.guild.channels.fetch(gc.logsChannelId).catch(() => null);
            if (logCh) await logCh.send({ embeds: [reportEmbed] });
          }

          saveData(data);
          return interaction.editReply({ embeds: [reportEmbed] });
        }

        if (sub === 'approval_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.approvalChannelId = interaction.options.getChannel('channel').id;
          saveConfig();
          return interaction.reply({ content: `ARCUS: Operation approval channel set to <#${gc.approvalChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'approval_toggle') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.requireOpApproval = interaction.options.getBoolean('enabled');
          saveConfig();
          return interaction.reply({ content: `ARCUS: Operation approval ${gc.requireOpApproval ? 'enabled' : 'disabled'}.`, flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op status ─────────────────────────────────────────────────────────
      if (group === 'status') {
        if (sub === 'set') {
          const stats = ensureUserStats(data, interaction.user.id);
          stats.availability     = interaction.options.getString('state');
          stats.availabilityNote = interaction.options.getString('note') || '';
          saveData(data);
          return interaction.reply({ content: `ARCUS: Availability set to **${stats.availability}**${stats.availabilityNote ? ` - ${stats.availabilityNote}` : ''}.`, flags: [MessageFlags.Ephemeral] });
        }
        if (sub === 'view') {
          const target = interaction.options.getUser('target') || interaction.user;
          const stats  = ensureUserStats(data, target.id);
          return interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle(`ARCUS Availability: ${target.username}`)
              .setDescription(`Status: **${stats.availability}**\nNote: ${stats.availabilityNote || '_None_'}`)
              .setColor(0x5865f2)],
            flags: [MessageFlags.Ephemeral]
          });
        }
      }

      // ── /op aar ────────────────────────────────────────────────────────────
      if (sub === 'aar') {
        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;
        if (interaction.user.id !== op.creatorId && !isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Only the creator or admin can file an AAR.', flags: [MessageFlags.Ephemeral] });

        const modal = new ModalBuilder().setCustomId(`op:modal:aar:${opKey}`).setTitle(`AAR: ${op.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_phases').setLabel('What happened (Phases / Timeline)').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Phase 1: Infiltration successful...')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_performance').setLabel('Personnel Evaluation').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        return interaction.showModal(modal);
      }

      // ── Channel configs ────────────────────────────────────────────────────
      if (sub === 'set_channel') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        gc.operationsChannelId = interaction.options.getChannel('channel').id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: Ops channel set to <#${gc.operationsChannelId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      if (sub === 'set_logs_channel') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        gc.logsChannelId = interaction.options.getChannel('channel').id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: Logs channel set to <#${gc.logsChannelId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      if (sub === 'set_announcement_channel') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        gc.announcementChannelId = interaction.options.getChannel('channel').id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: Announcements channel set to <#${gc.announcementChannelId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      if (sub === 'set_bct_channel') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        gc.bctChannelId = interaction.options.getChannel('channel').id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: BCT request channel set to <#${gc.bctChannelId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      if (sub === 'set_bct_role') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        gc.bctInstructorRoleId = interaction.options.getRole('role').id;
        saveConfig();
        return interaction.reply({ content: `ARCUS: BCT instructor role set to <@&${gc.bctInstructorRoleId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op log ────────────────────────────────────────────────────────────
      if (sub === 'log') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        if (!gc.logsChannelId) return interaction.reply({ content: 'ARCUS: Logs channel not configured.', flags: [MessageFlags.Ephemeral] });

        const ch = await interaction.guild.channels.fetch(gc.logsChannelId).catch(() => null);
        if (!ch)  return interaction.reply({ content: 'ARCUS: Logs channel not found.', flags: [MessageFlags.Ephemeral] });

        // FIX #5: use username instead of deprecated .tag
        await ch.send({ embeds: [new EmbedBuilder().setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() }).setDescription(interaction.options.getString('message')).setColor(0x808080).setTimestamp()] });
        return interaction.reply({ content: 'ARCUS: Entry logged.', flags: [MessageFlags.Ephemeral] });
      }

      // ── /op stats ──────────────────────────────────────────────────────────
      if (sub === 'stats') {
        await interaction.deferReply();
        isDeferred = true;

        const target       = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch({ user: target.id, force: true }).catch(() => null);
        const stats        = ensureUserStats(data, target.id);
        const currentRank  = getRank(targetMember, stats);
        const rankIndex    = ranks.indexOf(currentRank);
        const nextRank     = rankIndex >= 0 && rankIndex < ranks.length - 1 ? ranks[rankIndex + 1] : null;
        const opsToNext    = nextRank && !nextRank.appointed ? `\`${Math.max(0, nextRank.minAttended - stats.attended)}\`` : 'N/A';

        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(`ARCUS Record: ${targetMember?.nickname || target.username}`)
            .setThumbnail(target.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: 'Rank',         value: `**${currentRank.name}**`, inline: true },
              { name: 'Ops to Next',  value: opsToNext, inline: true },
              { name: 'Ops Attended', value: `\`${stats.attended}\``, inline: true }
            ).setColor(0x5865f2)]
        });
      }

      // ── /op award ──────────────────────────────────────────────────────────
      if (sub === 'award') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply();
        isDeferred = true;

        const target = interaction.options.getUser('target');
        const medal  = interaction.options.getString('medal');

        const gc         = getGuildConfig(interaction.guildId);
        const registered = gc.commendations.find(c => c.name.toLowerCase() === medal.toLowerCase());
        const medalName  = registered ? registered.name : medal;
        const emoji      = registered?.emoji ? `${registered.emoji} ` : '';

        const stats = ensureUserStats(data, target.id);
        stats.medals.push({ name: medalName, date: new Date().toISOString().split('T')[0] });
        saveData(data);

        if (gc.announcementChannelId) {
          const annCh = await interaction.guild.channels.fetch(gc.announcementChannelId).catch(() => null);
          if (annCh) {
            await annCh.send({ embeds: [new EmbedBuilder().setTitle('🎖️ Commendation Issued').setDescription(`${emoji}**${medalName}** awarded to <@${target.id}> for outstanding service.`).setColor(0xFFD700).setTimestamp()] });
          }
        }
        return interaction.editReply({ content: `🎖️ **${medalName}** awarded to <@${target.id}>.` });
      }

      // FIX #1 & #4: /op revoke slash command handler — was entirely missing
      if (sub === 'revoke') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply({ ephemeral: true });
        isDeferred = true;

        const target    = interaction.options.getUser('target');
        const medalName = interaction.options.getString('medal');
        const stats     = ensureUserStats(data, target.id);

        const before = stats.medals.length;
        stats.medals = stats.medals.filter(m => m.name.toLowerCase() !== medalName.toLowerCase());

        if (stats.medals.length === before)
          return interaction.editReply({ content: `ARCUS: **${medalName}** not found on <@${target.id}>'s record.` });

        saveData(data);
        return interaction.editReply({ content: `✅ Revoked **${medalName}** from <@${target.id}>.` });
      }

      // ── /op profile ────────────────────────────────────────────────────────
      if (sub === 'profile') {
        await interaction.deferReply();
        isDeferred = true;

        const targetUser   = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch({ user: targetUser.id, force: true }).catch(() => null);
        const displayName  = targetMember?.nickname || targetUser.displayName || targetUser.username;
        const stats        = ensureUserStats(data, targetUser.id);
        const currentRank  = getRank(targetMember, stats);
        const rankIndex    = ranks.indexOf(currentRank);
        const nextRank     = rankIndex >= 0 && rankIndex < ranks.length - 1 ? ranks[rankIndex + 1] : null;

        let progressText = '*Max Rank Achieved*';
        let opsToNext    = 'N/A';

        if (nextRank) {
          if (nextRank.appointed) {
            progressText = `*Next: ${nextRank.name} (Appointed — contact command)*`;
          } else {
            const reqs      = [];
            const opsNeeded = Math.max(0, nextRank.minAttended - stats.attended);
            opsToNext = `\`${opsNeeded}\``;
            if (opsNeeded > 0) reqs.push(`${opsNeeded} Ops`);
            if (nextRank.requireBCT && !stats.passedBCT)                       reqs.push('BCT');
            if (nextRank.minLed && stats.ledOps < nextRank.minLed)             reqs.push(`${nextRank.minLed - stats.ledOps} Led Ops`);
            if (nextRank.minRecruits && stats.recruits < nextRank.minRecruits) reqs.push(`${nextRank.minRecruits - stats.recruits} Recruits`);
            progressText = `*Next: ${nextRank.name} (${reqs.length > 0 ? reqs.join(', ') : 'Eligible'})*`;
          }
        }

        const councilIdx     = ranks.findIndex(r => r.name === 'Council');
        const isCouncilAbove = rankIndex >= councilIdx;
        const gc             = getGuildConfig(interaction.guildId);
        const avatarURL      = targetUser.displayAvatarURL({ size: 256 });

        const embed = new EmbedBuilder()
          .setTitle(`ARCUS Service Record: ${displayName}`)
          .setThumbnail(avatarURL)
          .addFields(
            { name: 'Rank',             value: `**${currentRank.name}**`, inline: true },
            { name: 'Ops to Next Rank', value: opsToNext, inline: true },
            { name: 'Personnel Stats',  value: `Attended: \`${stats.attended}\`\nLed: \`${stats.ledOps}\`\nRecruits: \`${stats.recruits}\`` },
            { name: 'Availability',     value: `**${stats.availability}**${stats.availabilityNote ? `\n${stats.availabilityNote}` : ''}` },
            { name: 'Promotion Req.',   value: progressText }
          )
          .setColor(0x5865f2)
          .setTimestamp()
          .setFooter({ text: 'Operational Excellence through Data Synchronization' });

        if (currentRank.name === 'Recruit') {
          embed.addFields({ name: 'Qualification Status', value: `BCT: ${stats.passedBCT ? '✅ Passed' : '❌ Pending'}\nNotes: ${stats.promotionNotes || '_None_'}` });
        }
        if (stats.medals?.length) {
          const rack = stats.medals.map(m => {
            const reg = gc.commendations.find(c => c.name.toLowerCase() === m.name.toLowerCase());
            return reg?.emoji || '🏅';
          }).join(' ');
          embed.addFields({ name: 'Ribbon Rack', value: rack });
          const medalLines = stats.medals.map(m => `• **${m.name}** (${m.date})`).join('\n');
          embed.addFields({ name: 'Service Medals', value: medalLines });
        }
        if (isCouncilAbove) {
          embed.addFields({ name: 'Council Assignment', value: stats.councilNote || '_No assignment noted_' });
        }

        const components = [];
        if (isAuthorized(interaction.member, interaction.guildId)) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`op:prof_edit:${targetUser.id}`).setLabel('Edit Record').setEmoji('📝').setStyle(ButtonStyle.Secondary)
          );
          if (nextRank && !nextRank.appointed) {
            row.addComponents(new ButtonBuilder().setCustomId(`op:prof_promote:${targetUser.id}`).setLabel('Promote').setEmoji('🎖️').setStyle(ButtonStyle.Primary));
          }
          if (currentRank.name === 'Recruit' && !stats.passedBCT) {
            row.addComponents(new ButtonBuilder().setCustomId(`op:bct_pass:${targetUser.id}`).setLabel('Mark BCT Passed').setEmoji('✅').setStyle(ButtonStyle.Success));
          }
          if (row.components.length) components.push(row);

          const adminRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`op:prof_award_btn:${targetUser.id}`).setLabel('Award Medal').setEmoji('🏅').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`op:prof_revoke_btn:${targetUser.id}`).setLabel('Revoke Medal').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!stats.medals?.length)
          );
          components.push(adminRow);
        }

        return interaction.editReply({ embeds: [embed], components });
      }

      // ── /op leaderboard ────────────────────────────────────────────────────
      if (sub === 'leaderboard') {
        const entries = Object.entries(data.users);
        if (!entries.length) return interaction.reply({ content: 'ARCUS: No data yet.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferReply();
        isDeferred = true;

        const top = entries
          .map(([id, s]) => ({ id, attended: s.attended || 0, stats: s }))
          .sort((a, b) => b.attended - a.attended)
          .slice(0, 10);

        let text = '';
        for (let i = 0; i < top.length; i++) {
          const e      = top[i];
          const user   = await client.users.fetch(e.id).catch(() => ({ username: 'Unknown' }));
          const member = await interaction.guild.members.fetch({ user: e.id, force: true }).catch(() => null);
          const name   = member?.nickname || user.username;
          const medal  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i+1}.\``;
          text += `${medal} **${name}** — ${getRank(member, e.stats).name} — \`${e.attended} ops\`\n`;
        }

        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏆 ARCUS Operational Leaderboard').setDescription(text).setColor(0xFFA500).setFooter({ text: 'Top 10 by attendance' })] });
      }

      // ── /op motm ───────────────────────────────────────────────────────────
      if (sub === 'motm') {
        const now      = new Date();
        const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const scores   = new Map();

        for (const op of Object.values(data.operations || {})) {
          if (op.guildId !== interaction.guildId || !op.locked || !op.endedAt) continue;
          const ts = new Date(op.endedAt).getTime();
          if (isNaN(ts)) continue;
          const opMonth = `${new Date(ts).getUTCFullYear()}-${String(new Date(ts).getUTCMonth() + 1).padStart(2, '0')}`;
          if (opMonth !== monthKey) continue;
          for (const [userId, status] of Object.entries(op.attendance || {})) {
            if (status === true || status === 'Attended') scores.set(userId, (scores.get(userId) || 0) + 1);
          }
        }

        if (!scores.size) return interaction.reply({ content: 'ARCUS: No attended operations recorded for this month yet.', flags: [MessageFlags.Ephemeral] });
        const [winnerId, count] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
        const user = await client.users.fetch(winnerId).catch(() => ({ username: 'Unknown', displayAvatarURL: () => null }));
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle('ARCUS: Member of the Month')
            .setDescription(`<@${winnerId}> leads ${monthKey} with **${count} attended operation${count === 1 ? '' : 's'}**.`)
            .setThumbnail(user.displayAvatarURL?.({ size: 256 }) || null)
            .setColor(0xFFD700)]
        });
      }

      // ── /op clear_stats ────────────────────────────────────────────────────
      if (sub === 'clear_stats') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
        data.users = {};
        saveData(data);
        return interaction.reply({ content: 'ARCUS: All attendance statistics wiped.', flags: [MessageFlags.Ephemeral] });
      }

      // ── /op settings ───────────────────────────────────────────────────────
      if (sub === 'settings') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        const gc = getGuildConfig(interaction.guildId);
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:view:gen').setLabel('General').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
          new ButtonBuilder().setCustomId('settings:view:roles').setLabel('Tactical').setStyle(ButtonStyle.Secondary).setEmoji('🎯'),
          new ButtonBuilder().setCustomId('settings:view:perms').setLabel('Access').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
          new ButtonBuilder().setCustomId('settings:view:templates').setLabel('Mission').setStyle(ButtonStyle.Secondary).setEmoji('📂')
        );
        const ctrlRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:main').setLabel('Home').setStyle(ButtonStyle.Primary).setEmoji('🏠'),
          new ButtonBuilder().setCustomId('settings:edit:main').setLabel('Edit').setStyle(ButtonStyle.Success).setEmoji('📝'),
          new ButtonBuilder().setCustomId('settings:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🛑')
        );
        return interaction.reply({ embeds: [buildSettingsEmbed(gc)], components: [navRow, ctrlRow], flags: [MessageFlags.Ephemeral] });
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BUTTONS
    // ══════════════════════════════════════════════════════════════════════════
    else if (interaction.isButton()) {
      const parts     = interaction.customId.split(':');
      const namespace = parts[0];
      const action    = parts[1];
      const targetId  = parts.slice(2).join(':');

      // ── Template list ─────────────────────────────────────────────────────
      if (namespace === 'op' && action === 'template_list') {
        const guildId         = parts[2];
        const targetChannelId = parts[3];
        const gc              = getGuildConfig(guildId);
        const isPrivileged    = canCreateEvent(interaction.member, guildId);
        const filtered        = isPrivileged ? gc.templates : gc.templates.filter(t => t.authorId === interaction.user.id);

        const options = filtered.map((t, i) => ({
          label:       t.name,
          description: t.description.substring(0, 50),
          value:       `template_${i}_${guildId}_${targetChannelId}`
        }));

        return interaction.reply({
          content:    'ARCUS: Select a template:',
          components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('op:load_template').setPlaceholder('Choose template').addOptions(options))],
          flags:      [MessageFlags.Ephemeral]
        });
      }

      // ── BCT pass (manual, from profile embed) ─────────────────────────────
      if (namespace === 'op' && action === 'bct_pass') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const data  = loadData();
        const stats = ensureUserStats(data, targetId);
        stats.passedBCT = true;
        saveData(data);
        return interaction.reply({ content: `✅ <@${targetId}> marked as BCT Passed.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── Suggest Template button ───────────────────────────────────────────
      if (namespace === 'op' && action === 'suggest_btn') {
        const modal = new ModalBuilder().setCustomId('op:template:suggest_modal').setTitle('Suggest Mission Template');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_name').setLabel('Template Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_desc').setLabel('Default Briefing').setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_pings').setLabel('Default Pings (Roles)').setStyle(TextInputStyle.Short).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tmpl_reminder').setLabel('Reminder Intervals (mins)').setStyle(TextInputStyle.Short).setValue('60, 15'))
        );
        return interaction.showModal(modal);
      }

      // ── Award button trigger (from profile) ──────────────────────────────
      if (namespace === 'op' && action === 'prof_award_btn') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        if (!gc.commendations?.length)
          return interaction.reply({ content: 'ARCUS: Registry empty.', flags: [MessageFlags.Ephemeral] });
        const options = gc.commendations.map(c => ({ label: c.name, description: c.description.substring(0, 100), value: c.name })).slice(0, 25);
        return interaction.reply({
          content:    `Choose a commendation for <@${targetId}>:`,
          components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`op:menu:award_select:${targetId}`).setPlaceholder('Select a medal').addOptions(options))],
          flags:      [MessageFlags.Ephemeral]
        });
      }

      // ── Revoke button trigger (from profile) ─────────────────────────────
      if (namespace === 'op' && action === 'prof_revoke_btn') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const data  = loadData();
        const stats = ensureUserStats(data, targetId);
        if (!stats.medals?.length)
          return interaction.reply({ content: 'ARCUS: This operator has no medals to revoke.', flags: [MessageFlags.Ephemeral] });
        const options = stats.medals.map((m, i) => ({
          label: m.name,
          description: `Awarded ${m.date}`,
          value: `${targetId}|${m.name}|${i}`
        })).slice(0, 25);
        return interaction.reply({
          content:    `Select a medal to revoke from <@${targetId}>:`,
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`op:menu:revoke_select:${targetId}`)
              .setPlaceholder('Select medal to revoke')
              .addOptions(options)
          )],
          flags: [MessageFlags.Ephemeral]
        });
      }

      // ── Op approve/deny (approval workflow) ───────────────────────────────
      if (namespace === 'op' && (action === 'op_approve' || action === 'op_deny')) {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        const pendingId = parts[2];
        const data      = loadData();
        const draft     = data.pendingOps?.[pendingId];
        if (!draft || draft.guildId !== interaction.guildId)
          return interaction.reply({ content: 'ARCUS: Pending operation not found.', flags: [MessageFlags.Ephemeral] });

        if (action === 'op_deny') {
          delete data.pendingOps[pendingId];
          saveData(data);
          await interaction.message.edit({ components: [] }).catch(() => {});
          return interaction.reply({ content: `ARCUS: Operation request **${draft.name}** denied.`, flags: [MessageFlags.Ephemeral] });
        }

        const op = await createOperationFromDraft(client, draft);
        delete data.pendingOps[pendingId];
        saveData(data);
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.reply({ content: `ARCUS: Operation **${op.name}** approved and posted.\nID: \`${op.id}\``, flags: [MessageFlags.Ephemeral] });
      }

      // ── BCT accept/deny (from BCT request in bct channel) ─────────────────
      if (namespace === 'op' && (action === 'bct_accept' || action === 'bct_deny')) {
        const guildId   = parts[2];
        const recruitId = parts[3];
        const gc        = getGuildConfig(guildId);
        if (!interaction.member.roles.cache.has(gc.bctInstructorRoleId) && !isAuthorized(interaction.member, guildId))
          return interaction.reply({ content: 'ARCUS: BCT instructor role required.', flags: [MessageFlags.Ephemeral] });

        if (action === 'bct_deny') {
          await interaction.message.edit({ components: [] }).catch(() => {});
          return interaction.reply({ content: `ARCUS: BCT request denied for <@${recruitId}>.` });
        }

        const modal = new ModalBuilder()
          .setCustomId(`op:modal:bct_create:${guildId}:${recruitId}`)
          .setTitle('ARCUS: Schedule BCT');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bct_time').setLabel('Training Time').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Friday 20:00')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bct_desc').setLabel('Training Briefing').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue('Basic Combat Training qualification.'))
        );
        return interaction.showModal(modal);
      }

      // ── BCT complete (sent via DM after /op end on a BCT op) ──────────────
      if (namespace === 'op' && action === 'bct_complete') {
        const opId      = parts[2];
        const recruitId = parts[3];
        const data      = loadData();
        const op        = getOpById(data, opId);
        if (!op || op.type !== 'bct')
          return interaction.reply({ content: 'ARCUS: BCT operation not found.' });
        if (interaction.user.id !== op.creatorId)
          return interaction.reply({ content: 'ARCUS: Only the BCT instructor can confirm completion.' });

        const stats = ensureUserStats(data, recruitId);
        stats.passedBCT      = true;
        stats.promotionNotes = stats.promotionNotes || `BCT completed via operation ${op.id}.`;
        saveData(data);
        await interaction.message.edit({ components: [] }).catch(() => {});
        return interaction.reply({ content: `ARCUS: <@${recruitId}> marked as BCT Passed.` });
      }

      // ── Settings navigation ───────────────────────────────────────────────
      if (namespace === 'settings' && (action === 'view' || action === 'main')) {
        const category = action === 'view' ? targetId : 'main';
        const gc       = getGuildConfig(interaction.guildId);
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:view:gen').setLabel('General').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
          new ButtonBuilder().setCustomId('settings:view:roles').setLabel('Tactical').setStyle(ButtonStyle.Secondary).setEmoji('🎯'),
          new ButtonBuilder().setCustomId('settings:view:perms').setLabel('Access').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
          new ButtonBuilder().setCustomId('settings:view:templates').setLabel('Mission').setStyle(ButtonStyle.Secondary).setEmoji('📂')
        );
        const ctrlRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('settings:main').setLabel('Home').setStyle(ButtonStyle.Primary).setEmoji('🏠'),
          new ButtonBuilder().setCustomId(`settings:edit:${category}`).setLabel('Edit').setStyle(ButtonStyle.Success).setEmoji('📝'),
          new ButtonBuilder().setCustomId('settings:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🛑')
        );
        return interaction.update({ embeds: [buildSettingsEmbed(gc, category)], components: [navRow, ctrlRow] });
      }

      if (namespace === 'settings' && action === 'close') {
        await interaction.deferUpdate();
        return interaction.deleteReply();
      }

      // ── Settings edit ─────────────────────────────────────────────────────
      if (namespace === 'settings' && action === 'edit') {
        if (targetId === 'gen') {
          const gc = getGuildConfig(interaction.guildId);
          const modal = new ModalBuilder().setCustomId('settings:modal:gen').setTitle('ARCUS: General Configuration');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('max_size').setLabel('Max Squad Size (1-10)').setStyle(TextInputStyle.Short).setValue(String(gc.maxSquadSize || 4))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('def_role').setLabel('Default Auto-Join Role').setStyle(TextInputStyle.Short).setValue(gc.defaultRole || 'Point Man'))
          );
          return interaction.showModal(modal);
        }
        if (targetId === 'roles') {
          const modal = new ModalBuilder().setCustomId('settings:modal:roles').setTitle('ARCUS: Edit Tactical Registry');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('add_role').setLabel('Add Role (leave blank to skip)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Marksman')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('remove_role').setLabel('Remove Role (exact name)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Overwatch'))
          );
          return interaction.showModal(modal);
        }
        let helpText = 'Use `/op admin grant/revoke` for admins.\nUse `/op creator grant/revoke` for creators.';
        if (targetId === 'templates') helpText = 'Use `/op template add/remove/list` to manage templates.';
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Manual Control Required').setDescription(helpText).setColor(0xFFFF00)], flags: [MessageFlags.Ephemeral] });
      }

      // ── Template approve/reject ───────────────────────────────────────────
      if (namespace === 'op' && action === 'tmpl_approve') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const embed       = interaction.message.embeds[0];
        const name        = embed.title.replace('Template Suggestion: ', '');
        const desc        = embed.fields.find(f => f.name === 'Briefing')?.value  || '';
        const pings       = embed.fields.find(f => f.name === 'Pings')?.value     || '';
        const authorId    = embed.footer?.text?.split(': ')[1];
        const reminderRaw = embed.fields.find(f => f.name === 'Reminder')?.value  || '30';
        const reminder    = reminderRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

        const gc = getGuildConfig(interaction.guildId);
        gc.templates.push({ name, description: desc, pings, reminder, authorId });
        saveConfig();
        return interaction.update({ content: `✅ Approved by ${interaction.user.username}. Template saved.`, components: [] });
      }

      if (namespace === 'op' && action === 'tmpl_reject') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        return interaction.update({ content: `❌ Rejected by ${interaction.user.username}.`, components: [] });
      }

      // ── Op setup modal trigger ────────────────────────────────────────────
      if (namespace === 'op' && action === 'setup') {
        const guildId   = parts[2] || interaction.guildId;
        const channelId = parts[3];
        const modal = new ModalBuilder().setCustomId(`op:modal:submit:${guildId}:${channelId}`).setTitle('ARCUS: New Operation');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_name').setLabel('Operation Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_time').setLabel('Start Time').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Friday 20:00')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_description').setLabel('Briefing / Objective').setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_pings').setLabel('Roles to Ping (Optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. Admin, Moderator')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_reminder').setLabel('Reminders (mins)').setStyle(TextInputStyle.Short).setRequired(false).setValue('60, 15'))
        );
        return interaction.showModal(modal);
      }

      // ── Prof edit modal trigger ───────────────────────────────────────────
      if (namespace === 'op' && action === 'prof_edit') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const data   = loadData();
        const ustats = ensureUserStats(data, targetId);
        const modal  = new ModalBuilder().setCustomId(`op:modal:prof_edit:${targetId}`).setTitle('Edit Operator Record');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bct_status').setLabel('BCT Passed? (yes/no)').setStyle(TextInputStyle.Short).setValue(ustats.passedBCT ? 'yes' : 'no')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('attended_ops').setLabel('Attended Ops Count').setStyle(TextInputStyle.Short).setValue(String(ustats.attended))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('led_ops').setLabel('Led Ops Count').setStyle(TextInputStyle.Short).setValue(String(ustats.ledOps))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('recruit_count').setLabel('Recruits Brought In').setStyle(TextInputStyle.Short).setValue(String(ustats.recruits))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('council_note').setLabel('Council Note / Assignment').setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(ustats.councilNote || ''))
        );
        return interaction.showModal(modal);
      }

      // ── Prof promote ──────────────────────────────────────────────────────
      if (namespace === 'op' && action === 'prof_promote') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        await interaction.deferUpdate();
        isDeferred = true;

        const data   = loadData();
        const stats  = ensureUserStats(data, targetId);
        const member = await interaction.guild.members.fetch({ user: targetId, force: true }).catch(() => null);
        if (!member) return interaction.followUp({ content: 'Operator not found in server.', flags: [MessageFlags.Ephemeral] });

        const currentRank = getRank(member, stats);
        const rankIndex   = ranks.indexOf(currentRank);
        const nextRank    = rankIndex >= 0 && rankIndex < ranks.length - 1 ? ranks[rankIndex + 1] : null;
        if (!nextRank)          return interaction.followUp({ content: 'Operator is at max rank.', flags: [MessageFlags.Ephemeral] });
        if (nextRank.appointed) return interaction.followUp({ content: `**${nextRank.name}** is an appointed position — assign manually.`, flags: [MessageFlags.Ephemeral] });

        if (nextRank.name === 'Sergeant' && !stats.passedBCT)              return interaction.followUp({ content: 'Ineligible: BCT not passed.', flags: [MessageFlags.Ephemeral] });
        if (stats.attended < nextRank.minAttended)                          return interaction.followUp({ content: `Ineligible: Needs ${nextRank.minAttended} ops (current: ${stats.attended}).`, flags: [MessageFlags.Ephemeral] });
        if (nextRank.minLed && stats.ledOps < nextRank.minLed)             return interaction.followUp({ content: `Ineligible: Needs ${nextRank.minLed} led ops (current: ${stats.ledOps}).`, flags: [MessageFlags.Ephemeral] });
        if (nextRank.minRecruits && stats.recruits < nextRank.minRecruits) return interaction.followUp({ content: `Ineligible: Needs ${nextRank.minRecruits} recruits (current: ${stats.recruits}).`, flags: [MessageFlags.Ephemeral] });

        const newRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === nextRank.name.toLowerCase());
        if (newRole) {
          const oldRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === currentRank.name.toLowerCase());
          if (oldRole && oldRole.id !== newRole.id) await member.roles.remove(oldRole).catch(console.error);
          await member.roles.add(newRole).catch(console.error);
        }

        const gc = getGuildConfig(interaction.guildId);
        if (gc.announcementChannelId) {
          const annCh = await interaction.guild.channels.fetch(gc.announcementChannelId).catch(() => null);
          if (annCh) {
            await annCh.send({ embeds: [new EmbedBuilder().setTitle('🎖️ Personnel Promotion').setDescription(`<@${targetId}> promoted to **${nextRank.name}**!`).setColor(0x00FF00).setTimestamp()] });
          }
        }
        try { await member.send(`🎖️ **ARCUS**: You have been promoted to **${nextRank.name}**!`); } catch { }
        return interaction.followUp({ content: `✅ <@${targetId}> promoted to **${nextRank.name}**.` });
      }

      // ── AAR trigger (guild channel button OR DM button) ───────────────────
      if (namespace === 'op' && action === 'aar_trigger') {
        const data    = loadData();
        const opEntry = findOpEntryById(data, targetId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.' });
        const { key: opKey, op } = opEntry;
        const modal = new ModalBuilder().setCustomId(`op:modal:aar:${opKey}`).setTitle(`AAR: ${op.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_phases').setLabel('What happened (Phases / Timeline)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_performance').setLabel('Personnel Evaluation').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        return interaction.showModal(modal);
      }

      // ── Op join/leave/role/squad/ready ────────────────────────────────────
      if (namespace !== 'op') return;

      const data    = loadData();
      const opEntry = findOpEntryById(data, targetId, interaction.guildId);
      if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
      const { key: opKey, op } = opEntry;
      if (op.locked) return interaction.reply({ content: 'ARCUS: Operation is locked.', flags: [MessageFlags.Ephemeral] });

      const gc = getGuildConfig(op.guildId);

      if (action === 'ready') {
        await interaction.deferReply({ ephemeral: true });
        isDeferred = true;

        op.readyUsers ??= [];
        const wasReady = op.readyUsers.includes(interaction.user.id);
        op.readyUsers  = wasReady
          ? op.readyUsers.filter(id => id !== interaction.user.id)
          : [...op.readyUsers, interaction.user.id];
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.editReply({ content: wasReady ? 'ARCUS: Ready status cleared.' : 'ARCUS: You are marked ready.' });
      }

      if (action === 'join') {
        if (findUserSquad(op, interaction.user.id))
          return interaction.reply({ content: 'ARCUS: You are already in a squad.', flags: [MessageFlags.Ephemeral] });

        const squad = op.squads.find(s => s.members.length < (gc.maxSquadSize || 4));
        if (!squad)
          return interaction.reply({ content: 'ARCUS: All squads are full.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferUpdate();
        isDeferred = true;

        const role = interaction.user.id === op.creatorId ? 'Squad Lead' : (gc.defaultRole || 'Point Man');
        squad.members.push({ userId: interaction.user.id, username: interaction.user.username, role });
        if (!op.participants.find(u => u.userId === interaction.user.id))
          op.participants.push({ userId: interaction.user.id, username: interaction.user.username });
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: 'ARCUS: Operator assigned.', flags: [MessageFlags.Ephemeral] });
      }

      if (action === 'leave') {
        const squad = findUserSquad(op, interaction.user.id);
        if (!squad)
          return interaction.reply({ content: 'ARCUS: You are not in this operation.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferUpdate();
        isDeferred = true;

        squad.members = squad.members.filter(m => m.userId !== interaction.user.id);
        if (squad.members.length === 0 && squad.name !== 'Alpha')
          op.squads = op.squads.filter(s => s.name !== squad.name);
        op.participants = op.participants.filter(p => p.userId !== interaction.user.id);
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: 'ARCUS: You have left the operation.', flags: [MessageFlags.Ephemeral] });
      }

      if (action === 'role') {
        const selectable = op.selectableRoles?.length ? op.selectableRoles : (gc.selectableRoles || ['Point Man', 'Overwatch', 'Medic', 'Demolitions']);
        return interaction.reply({
          content:    'ARCUS: Select your role.',
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`op:roleselect:${opKey}`).setPlaceholder('Choose a role').addOptions(selectable.map(r => ({ label: r, value: r }))).setMinValues(1).setMaxValues(1)
          )],
          flags: [MessageFlags.Ephemeral]
        });
      }

      if (action === 'squad') {
        if (!canCreateSquad(interaction.member, op.guildId))
          return interaction.reply({ content: 'ARCUS: You lack squad creation permission.', flags: [MessageFlags.Ephemeral] });

        const maxSize = gc.maxSquadSize || 4;
        const allFull = op.squads.every(s => s.members.length >= maxSize);
        if (!allFull)
          return interaction.reply({ content: `ARCUS: All existing squads must be full (${maxSize}) before creating a new one.`, flags: [MessageFlags.Ephemeral] });

        const nextName = getNextSquadName(op);
        if (!nextName)
          return interaction.reply({ content: 'ARCUS: Maximum squads reached.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferUpdate();
        isDeferred = true;

        const old = findUserSquad(op, interaction.user.id);
        if (old) {
          old.members = old.members.filter(m => m.userId !== interaction.user.id);
          if (old.members.length === 0 && old.name !== 'Alpha') op.squads = op.squads.filter(s => s.name !== old.name);
        }

        op.squads.push({ name: nextName, members: [{ userId: interaction.user.id, username: interaction.user.username, role: 'Squad Lead' }] });
        if (!op.participants.find(u => u.userId === interaction.user.id))
          op.participants.push({ userId: interaction.user.id, username: interaction.user.username });

        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: `ARCUS: Squad **${nextName}** created.`, flags: [MessageFlags.Ephemeral] });
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SELECT MENUS
    // ══════════════════════════════════════════════════════════════════════════
    else if (interaction.isStringSelectMenu()) {
      const parts     = interaction.customId.split(':');
      const namespace = parts[0];
      const action    = parts[1];

      if (interaction.customId === 'op:load_template') {
        const [, idx, guildId, channelId] = interaction.values[0].split('_');
        const gc       = getGuildConfig(guildId);
        const template = gc.templates[parseInt(idx)];
        const modal    = new ModalBuilder().setCustomId(`op:modal:submit:${guildId}:${channelId}`).setTitle('New Operation');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_name').setLabel('Operation Name').setStyle(TextInputStyle.Short).setValue(template.name)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_time').setLabel('Start Time').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Friday 20:00')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_description').setLabel('Briefing / Objective').setStyle(TextInputStyle.Paragraph).setValue(template.description)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_pings').setLabel('Roles to Ping (Optional)').setStyle(TextInputStyle.Short).setRequired(false).setValue(template.pings || '')),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('op_reminder').setLabel('Reminders (mins)').setStyle(TextInputStyle.Short).setRequired(false).setValue(Array.isArray(template.reminder) ? template.reminder.join(', ') : String(template.reminder || '60, 15')))
        );
        return interaction.showModal(modal);
      }

      if (action === 'roleselect') {
        const opId    = parts[2];
        const data    = loadData();
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry || opEntry.op.locked) return interaction.reply({ content: 'ARCUS: Operation not found or locked.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;

        const squad = findUserSquad(op, interaction.user.id);
        if (!squad) return interaction.reply({ content: 'ARCUS: Join the operation first.', flags: [MessageFlags.Ephemeral] });

        await interaction.deferUpdate();
        isDeferred = true;

        const selected = interaction.values[0];
        const caps     = { Medic: 1, Overwatch: 1, Demolitions: 1, 'Squad Lead': 1 };
        if (caps[selected]) {
          const count = squad.members.filter(m => m.role === selected && m.userId !== interaction.user.id).length;
          if (count >= caps[selected]) return interaction.followUp({ content: `ARCUS: This squad already has a ${selected}.`, flags: [MessageFlags.Ephemeral] });
        }
        if (selected === 'Squad Lead' && !canCreateEvent(interaction.member, op.guildId))
          return interaction.followUp({ content: 'ARCUS: Squad Lead requires Event Creator permissions.', flags: [MessageFlags.Ephemeral] });

        const m = squad.members.find(m => m.userId === interaction.user.id);
        if (m) m.role = selected;
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);
        return interaction.followUp({ content: `ARCUS: Role set to **${selected}**.`, flags: [MessageFlags.Ephemeral] });
      }

      // FIX #6: attendance handler arrives via DM — use deferReply not deferUpdate
      if (action === 'attendance') {
        const opId    = parts[2];
        const data    = loadData();
        const opEntry = findOpEntryById(data, opId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.' });
        const { key: opKey, op } = opEntry;

        if (interaction.user.id !== op.creatorId)
          return interaction.reply({ content: 'ARCUS: Only the operation creator can confirm attendance.' });

        // FIX #6: deferUpdate is invalid in DMs; use deferReply instead
        await interaction.deferReply();
        isDeferred = true;

        const attended = new Set(interaction.values);
        op.attendance  = {};

        for (const p of (op.participants || [])) {
          const wasAttended = attended.has(p.userId);
          op.attendance[p.userId] = wasAttended ? 'Attended' : 'Absent';
          if (op.attendanceRecorded) continue;

          const ustats = ensureUserStats(data, p.userId);
          ustats.joined += 1;
          if (wasAttended) {
            ustats.attended      += 1;
            ustats.lastAttendedAt = new Date().toISOString();
            const isLead = op.squads.some(s => s.members.some(m => m.userId === p.userId && m.role === 'Squad Lead'));
            if (isLead) ustats.ledOps += 1;
          }
        }

        op.attendanceRecorded = true;
        data.operations[opKey] = op;
        saveData(data);

        try {
          const ch = await client.channels.fetch(op.channelId);
          if (ch) await ch.send(`ARCUS: Attendance recorded for **${op.name}**.`);
        } catch { }

        return interaction.editReply({ content: 'ARCUS: Attendance confirmed and tracked.' });
      }

      // ── Award medal from select (profile award button flow) ───────────────
      if (action === 'menu' && parts[2] === 'award_select') {
        const awardTargetId = parts[3];
        const medalName     = interaction.values[0];
        const gc            = getGuildConfig(interaction.guildId);
        const data          = loadData();

        const registered = gc.commendations.find(c => c.name === medalName);
        const finalName  = registered ? registered.name : medalName;
        const emoji      = registered?.emoji ? `${registered.emoji} ` : '';

        const stats = ensureUserStats(data, awardTargetId);
        stats.medals.push({ name: finalName, date: new Date().toISOString().split('T')[0] });
        saveData(data);

        if (gc.announcementChannelId) {
          const annCh = await interaction.guild.channels.fetch(gc.announcementChannelId).catch(() => null);
          if (annCh) {
            await annCh.send({ embeds: [new EmbedBuilder().setTitle('🎖️ Commendation Issued').setDescription(`${emoji}**${finalName}** awarded to <@${awardTargetId}>.`).setColor(0xFFD700).setTimestamp()] });
          }
        }
        return interaction.reply({ content: `🎖️ **${finalName}** awarded to <@${awardTargetId}>.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── Revoke medal from select (profile revoke button flow) ─────────────
      if (action === 'menu' && parts[2] === 'revoke_select') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });

        // Value format: "userId|medalName|index"
        const [userId, medalName, idxStr] = interaction.values[0].split('|');
        const idx  = parseInt(idxStr);
        const data = loadData();
        const stats = ensureUserStats(data, userId);

        // Remove by index to safely handle duplicate medal names
        if (!isNaN(idx) && stats.medals[idx]?.name === medalName) {
          stats.medals.splice(idx, 1);
          saveData(data);
          return interaction.reply({ content: `✅ Revoked **${medalName}** from <@${userId}>.`, flags: [MessageFlags.Ephemeral] });
        }
        // Fallback: remove first matching name if index is stale
        const before = stats.medals.length;
        stats.medals = stats.medals.filter(m => m.name !== medalName);
        if (stats.medals.length < before) {
          saveData(data);
          return interaction.reply({ content: `✅ Revoked **${medalName}** from <@${userId}>.`, flags: [MessageFlags.Ephemeral] });
        }
        return interaction.reply({ content: 'ARCUS: Medal not found — it may have already been removed.', flags: [MessageFlags.Ephemeral] });
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MODAL SUBMITS
    // ══════════════════════════════════════════════════════════════════════════
    else if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(':');

      // ── Template add ───────────────────────────────────────────────────────
      if (interaction.customId === 'op:template:add_modal') {
        const name        = interaction.fields.getTextInputValue('tmpl_name');
        const description = interaction.fields.getTextInputValue('tmpl_desc');
        const pings       = safeGetField(interaction, 'tmpl_pings') || '';
        const reminderRaw = safeGetField(interaction, 'tmpl_reminder') || '30';
        const reminder    = reminderRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

        const gc = getGuildConfig(interaction.guildId);
        if (!gc.templates) gc.templates = [];
        gc.templates.push({ name, description, pings, reminder });
        saveConfig();
        return interaction.reply({ content: `ARCUS: Template **${name}** registered.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── Commendation add ───────────────────────────────────────────────────
      if (interaction.customId === 'op:modal:commendation:add') {
        const name  = interaction.fields.getTextInputValue('comm_name');
        const desc  = interaction.fields.getTextInputValue('comm_desc');
        const reqs  = interaction.fields.getTextInputValue('comm_reqs');
        const emoji = safeGetField(interaction, 'comm_emoji') || '';
        const image = safeGetField(interaction, 'comm_image') || '';

        const gc = getGuildConfig(interaction.guildId);
        if (!gc.commendations) gc.commendations = [];
        gc.commendations = gc.commendations.filter(c => c.name.toLowerCase() !== name.toLowerCase());
        gc.commendations.push({ name, description: desc, requirements: reqs, emoji, image });
        saveConfig();
        return interaction.reply({ content: `ARCUS: Commendation **${name}** added to the registry.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── Template suggest ──────────────────────────────────────────────────
      if (interaction.customId === 'op:template:suggest_modal') {
        const name     = interaction.fields.getTextInputValue('tmpl_name');
        const desc     = interaction.fields.getTextInputValue('tmpl_desc');
        const pings    = safeGetField(interaction, 'tmpl_pings') || 'None';
        const reminder = safeGetField(interaction, 'tmpl_reminder') || '30';

        const gc = getGuildConfig(interaction.guildId);
        if (!gc.logsChannelId) return interaction.reply({ content: 'ARCUS: Log channel not configured.', flags: [MessageFlags.Ephemeral] });
        const logCh = await interaction.guild.channels.fetch(gc.logsChannelId).catch(() => null);
        if (!logCh)  return interaction.reply({ content: 'ARCUS: Log channel not found.', flags: [MessageFlags.Ephemeral] });

        const targetCh = gc.approvalChannelId ? await client.channels.fetch(gc.approvalChannelId).catch(() => logCh) : logCh;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('op:tmpl_approve').setLabel('Approve & Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('op:tmpl_reject').setLabel('Reject').setStyle(ButtonStyle.Danger)
        );
        await targetCh.send({
          embeds: [new EmbedBuilder()
            .setTitle(`Template Suggestion: ${name}`)
            // FIX #5: use username instead of deprecated .tag
            .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
            .addFields({ name: 'Briefing', value: desc }, { name: 'Pings', value: pings, inline: true }, { name: 'Reminder', value: reminder, inline: true })
            .setColor(0x3498db)
            .setFooter({ text: `AuthorID: ${interaction.user.id}` })],
          components: [row]
        });
        return interaction.reply({ content: 'ARCUS: Template submitted for review.', flags: [MessageFlags.Ephemeral] });
      }

      // ── Settings: roles ───────────────────────────────────────────────────
      if (interaction.customId === 'settings:modal:roles') {
        const gc     = getGuildConfig(interaction.guildId);
        const add    = (safeGetField(interaction, 'add_role')    || '').trim();
        const remove = (safeGetField(interaction, 'remove_role') || '').trim();
        const feedback = [];

        if (add && !gc.selectableRoles.some(r => r.toLowerCase() === add.toLowerCase())) {
          gc.selectableRoles.push(add);
          feedback.push(`Added **${add}**`);
        }
        if (remove) {
          const before = gc.selectableRoles.length;
          gc.selectableRoles = gc.selectableRoles.filter(r => r.toLowerCase() !== remove.toLowerCase());
          if (gc.selectableRoles.length < before) feedback.push(`Removed **${remove}**`);
        }
        saveConfig();
        return interaction.reply({ content: feedback.length ? `Registry Updated: ${feedback.join(', ')}` : 'No changes made.', flags: [MessageFlags.Ephemeral] });
      }

      // ── Settings: general ─────────────────────────────────────────────────
      if (interaction.customId === 'settings:modal:gen') {
        const gc      = getGuildConfig(interaction.guildId);
        const size    = parseInt(interaction.fields.getTextInputValue('max_size'));
        const defRole = interaction.fields.getTextInputValue('def_role').trim();

        if (isNaN(size) || size < 1 || size > 10)
          return interaction.reply({ content: 'Invalid squad size (1–10).', flags: [MessageFlags.Ephemeral] });
        if (!gc.selectableRoles.some(r => r.toLowerCase() === defRole.toLowerCase()))
          return interaction.reply({ content: `⚠️ "${defRole}" is not in the Tactical Role registry. Add it first.`, flags: [MessageFlags.Ephemeral] });

        gc.maxSquadSize = size;
        gc.defaultRole  = defRole;
        saveConfig();
        return interaction.reply({ content: 'ARCUS: General settings updated.', flags: [MessageFlags.Ephemeral] });
      }

      // ── BCT create ────────────────────────────────────────────────────────
      if (parts[1] === 'modal' && parts[2] === 'bct_create') {
        const guildId   = parts[3];
        const recruitId = parts[4];
        if (guildId !== interaction.guildId)
          return interaction.reply({ content: 'ARCUS: BCT request guild mismatch.', flags: [MessageFlags.Ephemeral] });

        const time        = interaction.fields.getTextInputValue('bct_time');
        const description = interaction.fields.getTextInputValue('bct_desc');
        const op          = await createBctTrainingOperation(client, interaction, recruitId, time, description);
        await interaction.message?.edit({ components: [] }).catch(() => {});
        return interaction.reply({ content: `ARCUS: BCT training operation created for <@${recruitId}>.\nID: \`${op.id}\``, flags: [MessageFlags.Ephemeral] });
      }

      // ── AAR submit ────────────────────────────────────────────────────────
      if (parts[1] === 'modal' && parts[2] === 'aar') {
        const opId    = parts[3];
        const data    = loadData();
        const opEntry = findOpEntryById(data, opId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation data lost.' });
        const { key: opKey, op } = opEntry;

        op.aar_phases      = interaction.fields.getTextInputValue('aar_phases');
        op.aar_performance = safeGetField(interaction, 'aar_performance') || '';
        op.aarSubmitted    = true;
        op.aarSubmittedAt  = new Date().toISOString();
        data.operations[opKey] = op;
        saveData(data);
        await updateOperationMessage(client, op);

        if (op.aarRequestMessageId) {
          try {
            const ch  = await client.channels.fetch(op.channelId);
            const msg = await ch.messages.fetch(op.aarRequestMessageId);
            await msg.edit({
              embeds: [new EmbedBuilder()
                // FIX #5: use username instead of deprecated .tag
                .setTitle('✅ AAR Filed')
                .setDescription(`The report for **${op.name}** has been successfully archived by <@${interaction.user.id}>.`)
                .setColor(0x00FF00)
                .setTimestamp()],
              components: []
            });
          } catch { }
        }

        return interaction.reply({ content: `✅ AAR filed for **${op.name}**. Board updated.` });
      }

      // ── Create operation (from DM modal) ──────────────────────────────────
      if (parts[1] === 'modal' && parts[2] === 'submit') {
        const guildId   = parts[3];
        const channelId = parts[4];

        const name            = interaction.fields.getTextInputValue('op_name');
        const time            = interaction.fields.getTextInputValue('op_time');
        const description     = interaction.fields.getTextInputValue('op_description');
        const pingRaw         = safeGetField(interaction, 'op_pings') || '';
        const reminderRaw     = safeGetField(interaction, 'op_reminder') || '60, 15';
        const reminderMinutes = reminderRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
        const startTimeMs     = parseOpTime(time);

        const mapMatch = description.match(/(https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.gif|\.webp)(?:\?\S+)?)/i);
        const mapUrl   = mapMatch ? mapMatch[0] : null;

        if (name.length > 80)
          return interaction.reply({ content: 'ARCUS: Operation name must be 80 characters or less.', flags: [MessageFlags.Ephemeral] });
        if (description.length > 1000)
          return interaction.reply({ content: 'ARCUS: Briefing must be 1000 characters or less.', flags: [MessageFlags.Ephemeral] });
        if (isNaN(startTimeMs) || startTimeMs <= Date.now())
          return interaction.reply({ content: 'ARCUS: Start time must be a valid future time.', flags: [MessageFlags.Ephemeral] });
        if (reminderMinutes.some(mins => mins > 10080))
          return interaction.reply({ content: 'ARCUS: Reminder values must be 10080 minutes or less.', flags: [MessageFlags.Ephemeral] });

        const gc = getGuildConfig(guildId);

        const cachedGuild   = client.guilds.cache.get(guildId);
        const creatorMember = cachedGuild
          ? await cachedGuild.members.fetch({ user: interaction.user.id, force: false }).catch(() => null)
          : null;

        if (!canCreateEvent(creatorMember, guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized. You lack permissions to post this operation.', flags: [MessageFlags.Ephemeral] });

        const draft = {
          guildId,
          channelId,
          creatorId:  interaction.user.id,
          // FIX #5: use username instead of deprecated .tag
          creatorTag: interaction.user.username,
          name,
          time,
          description,
          pingRaw,
          reminderMinutes,
          mapUrl
        };

        if (gc.requireOpApproval && !isAuthorized(creatorMember, guildId)) {
          if (!gc.approvalChannelId)
            return interaction.reply({ content: 'ARCUS: Operation approval is enabled, but no approval channel is configured.', flags: [MessageFlags.Ephemeral] });
          const approvalChannel = await client.channels.fetch(gc.approvalChannelId).catch(() => null);
          if (!approvalChannel)
            return interaction.reply({ content: 'ARCUS: Approval channel not found.', flags: [MessageFlags.Ephemeral] });

          const data      = loadData();
          const pendingId = generateOpId({ operations: data.pendingOps || {} });
          data.pendingOps[pendingId] = { ...draft, requestedAt: new Date().toISOString() };
          saveData(data);

          await approvalChannel.send({
            embeds: [new EmbedBuilder()
              .setTitle('ARCUS: Operation Approval Required')
              .setDescription(`**${name}** submitted by <@${interaction.user.id}>.`)
              .addFields(
                { name: 'Time',           value: time,                          inline: true },
                { name: 'Target Channel', value: `<#${channelId}>`,             inline: true },
                { name: 'Briefing',       value: description.substring(0, 1000) }
              )
              .setColor(0xFFA500)
              .setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`op:op_approve:${pendingId}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`op:op_deny:${pendingId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
            )]
          });
          return interaction.reply({ content: `ARCUS: Operation **${name}** submitted for approval.`, flags: [MessageFlags.Ephemeral] });
        }

        const op              = await createOperationFromDraft(client, draft);
        const reminderDisplay = reminderMinutes.length ? reminderMinutes.map(m => `${m}m`).join(', ') : 'None';
        return interaction.reply({ content: `ARCUS: Operation **${name}** posted to <#${channelId}>.\nID: \`${op.id}\` | Reminders: \`${reminderDisplay}\`` });
      }

      // ── Profile edit ──────────────────────────────────────────────────────
      if (parts[1] === 'modal' && parts[2] === 'prof_edit') {
        const targetUserId = parts[3];
        const data         = loadData();
        const ustats       = ensureUserStats(data, targetUserId);

        const bctVal = safeGetField(interaction, 'bct_status');
        if (bctVal !== null) ustats.passedBCT = bctVal.toLowerCase() === 'yes' || bctVal.toLowerCase() === 'true';

        for (const { id, prop } of [
          { id: 'attended_ops',  prop: 'attended' },
          { id: 'led_ops',       prop: 'ledOps' },
          { id: 'recruit_count', prop: 'recruits' }
        ]) {
          const val = safeGetField(interaction, id);
          if (val !== null) {
            const num = parseInt(val);
            if (!isNaN(num)) ustats[prop] = num;
          }
        }

        const cNote = safeGetField(interaction, 'council_note');
        if (cNote !== null) ustats.councilNote = cNote;

        saveData(data);
        return interaction.reply({ content: `✅ Record updated for <@${targetUserId}>.`, flags: [MessageFlags.Ephemeral] });
      }
    }

  } catch (error) {
    console.error('ARCUS: Interaction Error:', error);
    try {
      const errMsg = { content: 'ARCUS Internal Error: Failed to process interaction.', flags: [MessageFlags.Ephemeral] };
      if (isDeferred) {
        await interaction.followUp(errMsg).catch(() => {});
      } else if (!interaction.replied) {
        await interaction.reply(errMsg).catch(() => {});
      }
    } catch (e) {
      console.error('ARCUS: Error reply failed:', e);
    }
  }
});

client.login(TOKEN);
