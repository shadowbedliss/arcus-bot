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
  Events,
  MessageFlags,
  Routes,
  ModalBuilder,
  ActivityType,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { REST }             = require('@discordjs/rest');
const { buildCommandData } = require('./commands');
const fs   = require('fs-extra');
const path = require('path');

// ─── Environment ──────────────────────────────────────────────────────────────
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
  console.error('ARCUS Critical: TOKEN or CLIENT_ID missing.');
  process.exit(1);
}
const TOKEN     = process.env.TOKEN.trim();
const CLIENT_ID = process.env.CLIENT_ID.trim();

if (TOKEN.includes('your_bot_token_here') || TOKEN.length < 50) {
  console.error('ARCUS Critical: TOKEN appears invalid.');
  process.exit(1);
}

// ─── Config & Data ────────────────────────────────────────────────────────────
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

function normalizeGuildConfig(gc) {
  let changed = false;
  const defaults = createDefaultGuildConfig();
  for (const [key, value] of Object.entries(defaults)) {
    if (gc[key] === undefined) { gc[key] = value; changed = true; }
  }
  for (const key of ['authorizedRoles','eventCreatorRoles','selectableRoles','templates','commendations']) {
    if (!Array.isArray(gc[key])) { gc[key] = defaults[key]; changed = true; }
  }
  return changed;
}

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) fs.writeJsonSync(configPath, { guilds: {} }, { spaces: 2 });
    const cfg = fs.readJsonSync(configPath);
    let changed = false;
    if (!cfg.guilds) { cfg.guilds = {}; changed = true; }
    for (const [guildId, gc] of Object.entries(cfg.guilds)) {
      if (!gc.defaultGuildId) { gc.defaultGuildId = guildId; changed = true; }
      if (normalizeGuildConfig(gc)) changed = true;
    }
    if (changed) fs.writeJsonSync(configPath, cfg, { spaces: 2 });
    return cfg;
  } catch (err) {
    console.warn(`ARCUS: Config load failed (${err.code}). Using empty config.`);
    return { guilds: {} };
  }
}
let config = loadConfig();

function saveConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const fresh = fs.readJsonSync(configPath);
      for (const [guildId, gc] of Object.entries(config.guilds || {})) {
        fresh.guilds[guildId] = gc;
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
    console.warn(`ARCUS: Data load failed (${err.code}). Using empty state.`);
    return { operations: {}, users: {}, pendingOps: {} };
  }
}
function saveData(data) { fs.writeJsonSync(DATA_FILE, data, { spaces: 2 }); }

// ─── Timezone Support ─────────────────────────────────────────────────────────
const TIMEZONE_OPTIONS = [
  { label: 'ET — New York (EST/EDT)',        value: 'America/New_York' },
  { label: 'CT — Chicago (CST/CDT)',         value: 'America/Chicago' },
  { label: 'MT — Denver (MST/MDT)',          value: 'America/Denver' },
  { label: 'PT — Los Angeles (PST/PDT)',     value: 'America/Los_Angeles' },
  { label: 'AT — Halifax (AST/ADT)',         value: 'America/Halifax' },
  { label: 'GMT — London (GMT/BST)',         value: 'Europe/London' },
  { label: 'CET — Berlin/Paris (CET/CEST)', value: 'Europe/Berlin' },
  { label: 'EET — Bratislava/Prague',        value: 'Europe/Bratislava' },
  { label: 'EET — Bucharest (EET/EEST)',     value: 'Europe/Bucharest' },
  { label: 'MSK — Moscow',                   value: 'Europe/Moscow' },
  { label: 'GST — Dubai',                    value: 'Asia/Dubai' },
  { label: 'IST — India',                    value: 'Asia/Kolkata' },
  { label: 'JST — Tokyo',                    value: 'Asia/Tokyo' },
  { label: 'AEST — Sydney',                  value: 'Australia/Sydney' },
  { label: 'NZST — Auckland',                value: 'Pacific/Auckland' },
];

function getUserTimezone(data, userId) {
  return data.users?.[userId]?.timezone || 'UTC';
}

/**
 * Convert a local datetime string (YYYY-MM-DDTHH:MM:SS) in a given
 * IANA timezone to a UTC timestamp in milliseconds.
 */
function zonedToUtc(localIso, timezone) {
  const parts = localIso.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);
  if (!parts) return NaN;
  let utcGuess = Date.UTC(...[parts[1], parts[2]-1, parts[3], parts[4], parts[5], parts[6]].map(Number));
  for (let i = 0; i < 3; i++) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(new Date(utcGuess));
    const p    = fmt.replace(/[^\d]/g, ' ').trim().split(/\s+/).map(Number);
    const diff = Date.UTC(p[0], p[1]-1, p[2], p[3], p[4], p[5]) - utcGuess;
    utcGuess  -= diff;
  }
  return utcGuess;
}

/**
 * Parse a human time string in the context of a given IANA timezone.
 * Accepts: "Friday 20:00", "Jun 15 20:00", "15/06 20:00",
 *          "tomorrow 19:00", "today 21:30", "20:00"
 * Returns UTC ms or NaN.
 */
function parseOpTimeWithTz(timeStr, timezone) {
  if (!timeStr || !timezone) return NaN;
  const str  = timeStr.trim();
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');

  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  let year  = parseInt(nowParts.year);
  let month = parseInt(nowParts.month) - 1;
  let day   = parseInt(nowParts.day);

  const timeMatch = str.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return NaN;
  const hours   = parseInt(timeMatch[1]);
  const minutes = parseInt(timeMatch[2]);
  if (hours > 23 || minutes > 59) return NaN;

  const dayStr   = str.toLowerCase().replace(/\d{1,2}:\d{2}/, '').trim();
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const months3  = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  if (!dayStr || dayStr === 'today') {
    // use current date in tz — handled below with past check
  } else if (dayStr === 'tomorrow') {
    const d = new Date(Date.UTC(year, month, day + 1));
    year = d.getUTCFullYear(); month = d.getUTCMonth(); day = d.getUTCDate();
  } else if (weekdays.some(w => dayStr.includes(w))) {
    const target  = weekdays.findIndex(w => dayStr.includes(w));
    const refDate = new Date(Date.UTC(year, month, day));
    const refDay  = weekdays.indexOf(
      refDate.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' }).toLowerCase()
    );
    let diff = (target - refDay + 7) % 7;
    if (diff === 0) diff = 7;
    const nd = new Date(Date.UTC(year, month, day + diff));
    year = nd.getUTCFullYear(); month = nd.getUTCMonth(); day = nd.getUTCDate();
  } else {
    const mdMatch = dayStr.match(/([a-z]{3})\s+(\d{1,2})/);
    const dmMatch = dayStr.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (mdMatch) {
      const mIdx = months3.indexOf(mdMatch[1].substring(0, 3));
      if (mIdx === -1) return NaN;
      month = mIdx;
      day   = parseInt(mdMatch[2]);
    } else if (dmMatch) {
      day   = parseInt(dmMatch[1]);
      month = parseInt(dmMatch[2]) - 1;
      if (dmMatch[3]) year = parseInt(dmMatch[3].length === 2 ? `20${dmMatch[3]}` : dmMatch[3]);
    } else {
      return NaN;
    }
  }

  const localIso  = `${year}-${pad(month+1)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00`;
  let   candidate = zonedToUtc(localIso, timezone);
  if (isNaN(candidate)) return NaN;

  // If past and no explicit date given, push to next day
  if (candidate <= now.getTime() && (!dayStr || dayStr === 'today' || dayStr === '')) {
    candidate = zonedToUtc(`${year}-${pad(month+1)}-${pad(day+1)}T${pad(hours)}:${pad(minutes)}:00`, timezone);
  }
  return candidate;
}

function resolveOpTimestamp(op, data) {
  const tz = getUserTimezone(data, op.creatorId);
  return parseOpTimeWithTz(op.time, tz);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function isAuthorized(member, guildId) {
  if (!member?.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const authRoles = getGuildConfig(guildId).authorizedRoles || [];
  return member.roles.cache.some(role =>
    authRoles.some(a => a.toLowerCase() === role.name.toLowerCase() || a === role.id)
  );
}

function canCreateEvent(member, guildId) {
  if (!member?.permissions) return false;
  if (member.permissions.has('Administrator')) return true;
  const gc = getGuildConfig(guildId);
  return isAuthorized(member, guildId) ||
    member.roles.cache.some(role => (gc.eventCreatorRoles || []).includes(role.id));
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

function buildOperationEmbed(op, data) {
  const startTime   = resolveOpTimestamp(op, data || loadData());
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

function buildCreatorRow(op) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`op:edit_menu:${op.id}`)
      .setLabel('Edit Op')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(op.locked)
  );
}

async function updateOperationMessage(client, op) {
  try {
    const data    = loadData();
    const channel = await client.channels.fetch(op.channelId);
    const message = await channel.messages.fetch(op.messageId);
    await message.edit({ embeds: [buildOperationEmbed(op, data)], components: [buildActionRow(op)] });
  } catch (err) {
    console.error('Failed to update operation message:', err);
  }
}

async function sendCreatorDm(client, op) {
  try {
    const creator = await client.users.fetch(op.creatorId);
    await creator.send({
      embeds: [new EmbedBuilder()
        .setTitle(`ARCUS: Op Created — ${op.name}`)
        .setDescription('Your operation has been posted.\nUse the button below to edit it at any time.')
        .addFields({ name: 'Op ID', value: `\`${op.id}\``, inline: true })
        .setColor(0x57f287)],
      components: [buildCreatorRow(op)]
    });
  } catch { /* DMs closed, non-fatal */ }
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
  const tz         = getUserTimezone(data, instructor.id);

  const startTimeMs = parseOpTimeWithTz(time, tz);

  let scheduledEventId = null;
  if (!isNaN(startTimeMs) && startTimeMs > Date.now()) {
    try {
      const ev = await guild.scheduledEvents.create({
        name: `BCT: ${recruit.username}`,
        description: description.substring(0, 1000),
        scheduledStartTime: new Date(startTimeMs),
        privacyLevel: 2, entityType: 3,
        entityMetadata: { location: `#${channel.name}` },
        reason: 'ARCUS BCT Training Created'
      });
      scheduledEventId = ev.id;
    } catch (e) { console.error('ARCUS: BCT scheduled event creation failed:', e); }
  }

  const opId = generateOpId(data);
  const op = {
    id: opId, type: 'bct', bctRecruitId: recruitId,
    channelId, messageId: null, guildId: guild.id,
    creatorId: instructor.id, creatorTag: instructor.username,
    name: `BCT - ${recruit.username}`, time, description,
    mapUrl: null, scheduledEventId,
    reminderMinutes: [], remindersSent: [],
    locked: false, attendanceRecorded: false,
    selectableRoles: gc.selectableRoles,
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
    embeds: [buildOperationEmbed(op, data)],
    components: [buildActionRow(op)]
  });
  op.messageId = msg.id;
  data.operations[opId] = op;
  saveData(data);
  await sendCreatorDm(client, op);
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

function getRank(member) {
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
  u.timezone         ??= null;
  return u;
}

function formatOperationTime(op, data) {
  const startTime = resolveOpTimestamp(op, data);
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
  const data = loadData();
  for (const [userId] of targets) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`🔔 **ARCUS Reminder**: Operation **${op.name}** is scheduled for ${formatOperationTime(op, data)}.${message ? `\n${message}` : ''}`);
      sent++;
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

  const tz          = getUserTimezone(data, draft.creatorId);
  const startTimeMs = parseOpTimeWithTz(draft.time, tz);

  let scheduledEventId = null;
  if (!isNaN(startTimeMs) && startTimeMs > Date.now()) {
    try {
      const ev = await guild.scheduledEvents.create({
        name: `Op: ${draft.name}`,
        description: draft.description.substring(0, 1000),
        scheduledStartTime: new Date(startTimeMs),
        privacyLevel: 2, entityType: 3,
        entityMetadata: { location: `#${channel.name}` },
        reason: 'ARCUS Operation Created'
      });
      scheduledEventId = ev.id;
    } catch (e) { console.error('ARCUS: Scheduled event creation failed:', e); }
  }

  const opId = generateOpId(data);
  const op = {
    id: opId, channelId: draft.channelId, messageId: null,
    guildId: draft.guildId, creatorId: draft.creatorId, creatorTag: draft.creatorTag,
    name: draft.name, time: draft.time, description: draft.description,
    mapUrl: draft.mapUrl || null, pingRaw: draft.pingRaw || '',
    scheduledEventId, reminderMinutes: draft.reminderMinutes || [],
    remindersSent: [], locked: false, attendanceRecorded: false,
    aarRequired: false, aarSubmitted: false,
    selectableRoles: gc.selectableRoles,
    squads: [{ name: 'Alpha', members: [] }],
    participants: [], attendance: {}
  };

  const msg = await channel.send({
    content: pingString || undefined,
    embeds: [buildOperationEmbed(op, data)],
    components: [buildActionRow(op)]
  });
  op.messageId = msg.id;
  data.operations[opId] = op;
  saveData(data);
  await sendCreatorDm(client, op);
  return op;
}

function buildReadySummary(op) {
  const ready = Array.isArray(op.readyUsers) ? op.readyUsers : [];
  return ready.length ? ready.map(id => `<@${id}>`).join('\n') : '_No operators ready yet._';
}

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

function safeGetField(interaction, fieldId) {
  try { return interaction.fields.getTextInputValue(fieldId) || null; }
  catch { return null; }
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

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`ARCUS ready: ${client.user.tag}`);
  client.user.setActivity('Operational Logs', { type: ActivityType.Watching });

  const rest        = new REST({ version: '10' }).setToken(TOKEN);
  const commandJSON = buildCommandData().toJSON();

  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [commandJSON] });
    const guilds = client.guilds.cache.map(g => g.id);
    for (const gId of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gId), { body: [commandJSON] });
        console.log(`ARCUS: Commands synced to guild ${gId}`);
      } catch (err) {
        console.error(`ARCUS: Failed to sync to guild ${gId}:`, err.message);
      }
    }
  } catch (error) {
    console.error('ARCUS: Command registration failed:', error);
  }

  // ─── Reminder loop ────────────────────────────────────────────────────────
  setInterval(async () => {
    const data  = loadData();
    let changed = false;
    const now   = Date.now();

    for (const opId in data.operations) {
      const op = data.operations[opId];
      if (op.locked) continue;
      const startTime = resolveOpTimestamp(op, data);
      if (!startTime || isNaN(startTime)) continue;

      const thresholds = Array.isArray(op.reminderMinutes) ? op.reminderMinutes : [];
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

    // ── Autocomplete ─────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const gc           = getGuildConfig(interaction.guildId);
      const focusedValue = interaction.options.getFocused();
      const choices      = (gc.commendations || []).map(c => c.name);
      const filtered     = choices.filter(c => c.toLowerCase().includes(focusedValue.toLowerCase())).slice(0, 25);
      return await interaction.respond(filtered.map(c => ({ name: c, value: c })));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // SLASH COMMANDS
    // ══════════════════════════════════════════════════════════════════════════
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'op') return;

      const sub   = interaction.options.getSubcommand(false);
      const group = interaction.options.getSubcommandGroup(false);
      const data  = loadData();

      // ── /op create ───────────────────────────────────────────────────────
      if (sub === 'create') {
        if (!canCreateEvent(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized. Creator permissions required.', flags: [MessageFlags.Ephemeral] });

        const gc              = getGuildConfig(interaction.guildId);
        const targetChannelId = gc.operationsChannelId || interaction.channelId;
        const userStats       = ensureUserStats(data, interaction.user.id);

        // If no timezone saved, ask first via DM
        if (!userStats.timezone) {
          const tzRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`op:tz_select:${interaction.guildId}:${targetChannelId}`)
              .setPlaceholder('Select your timezone')
              .addOptions(TIMEZONE_OPTIONS)
          );
          try {
            await interaction.user.send({
              embeds: [new EmbedBuilder()
                .setTitle('ARCUS: Timezone Setup')
                .setDescription("Before creating your first operation, select your timezone.\nThis is saved permanently and won't be asked again.")
                .setColor(0x5865f2)],
              components: [tzRow]
            });
            return interaction.reply({ content: 'ARCUS: Check your DMs to set your timezone first.', flags: [MessageFlags.Ephemeral] });
          } catch {
            return interaction.reply({ content: 'ARCUS: Could not DM you. Enable DMs and try again.', flags: [MessageFlags.Ephemeral] });
          }
        }

        // Timezone set — go to op setup
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`op:setup:${interaction.guildId}:${targetChannelId}`).setLabel('📝 Setup Operation').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`op:template_list:${interaction.guildId}:${targetChannelId}`).setLabel('📂 Use Template').setStyle(ButtonStyle.Secondary).setDisabled(!(gc.templates?.length > 0))
        );
        try {
          await interaction.user.send({
            embeds: [new EmbedBuilder()
              .setTitle('ARCUS: Operation Creation')
              .setDescription(`Creating op for <#${targetChannelId}>. Click below to configure.`)
              .setColor(0xed4245)],
            components: [row]
          });
          return interaction.reply({ content: 'ARCUS: Setup menu sent to your DMs.', flags: [MessageFlags.Ephemeral] });
        } catch {
          return interaction.reply({ content: 'ARCUS: Could not DM you. Enable DMs and try again.', flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op end ──────────────────────────────────────────────────────────
      if (sub === 'end') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });

        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;
        if (op.locked) return interaction.reply({ content: 'ARCUS: Operation already ended.', flags: [MessageFlags.Ephemeral] });

        op.locked = true; op.endedAt = new Date().toISOString();
        op.aarRequired = true; op.aarSubmitted = Boolean(op.aar_phases);
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
              .setColor(0xFFA500).setTimestamp()],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`op:aar_trigger:${opKey}`).setLabel('File AAR').setStyle(ButtonStyle.Primary)
            )]
          });
          op.aarRequestMessageId = aarMsg.id;
          data.operations[opKey] = op;
          saveData(data);
        } catch { }

        if (op.scheduledEventId) {
          try { const guild = await client.guilds.fetch(op.guildId); await guild.scheduledEvents.delete(op.scheduledEventId); } catch { }
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
          return interaction.reply({ content: 'ARCUS: Operation locked, but DM failed.', flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op delete ───────────────────────────────────────────────────────
      if (sub === 'delete') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });

        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;

        try { const ch = await client.channels.fetch(op.channelId); const msg = await ch.messages.fetch(op.messageId); await msg.delete(); } catch { }
        if (op.scheduledEventId) {
          try { const guild = await client.guilds.fetch(op.guildId); await guild.scheduledEvents.delete(op.scheduledEventId); } catch { }
        }
        delete data.operations[opKey];
        saveData(data);
        return interaction.reply({ content: `ARCUS: Operation **${op.name}** deleted.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op admin ────────────────────────────────────────────────────────
      if (group === 'admin') {
        if (!interaction.member.permissions.has('Administrator') && !isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Administrator required.', flags: [MessageFlags.Ephemeral] });
        const gc   = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
        if (sub === 'grant') { if (!gc.authorizedRoles.includes(role.id)) gc.authorizedRoles.push(role.id); }
        else { gc.authorizedRoles = gc.authorizedRoles.filter(id => id !== role.id); }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Admin list updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op creator ──────────────────────────────────────────────────────
      if (group === 'creator') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc   = getGuildConfig(interaction.guildId);
        const role = interaction.options.getRole('role');
        if (sub === 'grant') { if (!gc.eventCreatorRoles.includes(role.id)) gc.eventCreatorRoles.push(role.id); }
        else { gc.eventCreatorRoles = gc.eventCreatorRoles.filter(id => id !== role.id); }
        saveConfig();
        return interaction.reply({ content: `ARCUS: Creator permissions updated for **${role.name}**.`, flags: [MessageFlags.Ephemeral] });
      }

      // ── /op tactical ─────────────────────────────────────────────────────
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

      // ── /op template ─────────────────────────────────────────────────────
      if (group === 'template') {
        const gc = getGuildConfig(interaction.guildId);
        if (sub === 'add' || sub === 'suggest') {
          if (sub === 'add' && !isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          if (!canCreateEvent(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
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

      // ── /op commendation ─────────────────────────────────────────────────
      if (group === 'commendation') {
        const gc = getGuildConfig(interaction.guildId);
        if (sub === 'add') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const modal = new ModalBuilder().setCustomId('op:modal:commendation:add').setTitle('Add Commendation to Registry');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_name').setLabel('Medal Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Medal of Valor')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_desc').setLabel('Description / Purpose').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_reqs').setLabel('Requirements').setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_emoji').setLabel('Emoji / Icon').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 🎖️')),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comm_image').setLabel('Ribbon Image URL (Optional)').setStyle(TextInputStyle.Short).setRequired(false))
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
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🎖️ ARCUS Commendation Registry').setDescription(list).setColor(0xFFD700).setFooter({ text: 'Use /op award to recognize an operator' })] });
      }

      // ── /op bct ──────────────────────────────────────────────────────────
      if (group === 'bct' && sub === 'request') {
        const gc = getGuildConfig(interaction.guildId);
        if (!gc.bctChannelId)
          return interaction.reply({ content: 'ARCUS: BCT request channel not configured.', flags: [MessageFlags.Ephemeral] });
        if (!gc.bctInstructorRoleId)
          return interaction.reply({ content: 'ARCUS: BCT instructor role not configured.', flags: [MessageFlags.Ephemeral] });

        const stats = ensureUserStats(data, interaction.user.id);
        if (stats.passedBCT)
          return interaction.reply({ content: 'ARCUS: Your profile already shows BCT as passed.', flags: [MessageFlags.Ephemeral] });

        const ch = await interaction.guild.channels.fetch(gc.bctChannelId).catch(() => null);
        if (!ch) return interaction.reply({ content: 'ARCUS: BCT request channel not found.', flags: [MessageFlags.Ephemeral] });

        await ch.send({
          content: `<@&${gc.bctInstructorRoleId}>`,
          embeds: [new EmbedBuilder()
            .setTitle('ARCUS: BCT Request')
            .setDescription(`<@${interaction.user.id}> is requesting Basic Combat Training.`)
            .addFields(
              { name: 'Recruit', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Status',  value: 'Pending instructor acceptance', inline: true }
            ).setColor(0x5865f2).setTimestamp()],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`op:bct_accept:${interaction.guildId}:${interaction.user.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`op:bct_deny:${interaction.guildId}:${interaction.user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
          )]
        });
        return interaction.reply({ content: 'ARCUS: BCT request submitted.', flags: [MessageFlags.Ephemeral] });
      }

      // ── /op manage ───────────────────────────────────────────────────────
      if (group === 'manage') {
        if (sub === 'list') {
          const entries = Object.entries(data.operations || {})
            .filter(([, op]) => op.guildId === interaction.guildId && !op.locked)
            .sort(([, a], [, b]) => (resolveOpTimestamp(a, data) || 0) - (resolveOpTimestamp(b, data) || 0));
          if (!entries.length) return interaction.reply({ content: 'ARCUS: No active operations.', flags: [MessageFlags.Ephemeral] });
          const lines = entries.map(([key, op]) =>
            `\`${getOperationIdDisplay(key, op)}\` **${op.name}** - ${formatOperationTime(op, data)} - ${op.participants?.length || 0} signed`
          );
          return interaction.reply({ embeds: [new EmbedBuilder().setTitle('ARCUS: Active Operations').setDescription(lines.join('\n')).setColor(0x5865f2)], flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'remind') {
          const opId    = interaction.options.getString('id');
          const opEntry = findOpEntryById(data, opId, interaction.guildId);
          if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
          const { op } = opEntry;
          if (interaction.user.id !== op.creatorId && !isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Only the creator or admin can send reminders.', flags: [MessageFlags.Ephemeral] });
          await interaction.deferReply({ ephemeral: true }); isDeferred = true;
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
            return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          op.creatorId = target.id; op.creatorTag = target.username;
          data.operations[opKey] = op; saveData(data);
          await updateOperationMessage(client, op);
          return interaction.reply({ content: `ARCUS: Operation **${op.name}** transferred to <@${target.id}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'activity') {
          if (!isAuthorized(interaction.member, interaction.guildId))
            return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          await interaction.deferReply({ ephemeral: true }); isDeferred = true;

          const gc         = getGuildConfig(interaction.guildId);
          const members    = await interaction.guild.members.fetch().catch(() => null);
          const userEntries = Object.entries(data.users || {});
          const active = userEntries.filter(([, s]) => (s.attended || 0) > 0)
            .sort((a, b) => (b[1].attended || 0) - (a[1].attended || 0)).slice(0, 15);
          const inactive = members
            ? members.filter(m => !m.user.bot)
                .map(m => ({ member: m, stats: ensureUserStats(data, m.id) }))
                .filter(e => !e.stats.lastAttendedAt).slice(0, 12)
            : [];

          const activeText   = active.length ? active.map(([id, s]) => `<@${id}> - \`${s.attended || 0}\` attended - last: ${s.lastAttendedAt ? `<t:${Math.floor(new Date(s.lastAttendedAt).getTime() / 1000)}:R>` : 'unknown'}`).join('\n') : '_No attendance recorded._';
          const inactiveText = inactive.length ? inactive.map(({ member }) => `<@${member.id}>`).join('\n') : '_No inactive members found._';

          const reportEmbed = new EmbedBuilder()
            .setTitle('📊 ARCUS: Tactical Activity Report')
            .setDescription(`Generated by <@${interaction.user.id}>`)
            .addFields({ name: '🔥 Most Active', value: activeText }, { name: '🧊 Inactive', value: inactiveText })
            .setColor(0x5865f2).setTimestamp();

          if (gc.logsChannelId) {
            const logCh = await interaction.guild.channels.fetch(gc.logsChannelId).catch(() => null);
            if (logCh) await logCh.send({ embeds: [reportEmbed] });
          }
          saveData(data);
          return interaction.editReply({ embeds: [reportEmbed] });
        }

        if (sub === 'approval_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.approvalChannelId = interaction.options.getChannel('channel').id; saveConfig();
          return interaction.reply({ content: `ARCUS: Approval channel set to <#${gc.approvalChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'approval_toggle') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.requireOpApproval = interaction.options.getBoolean('enabled'); saveConfig();
          return interaction.reply({ content: `ARCUS: Operation approval ${gc.requireOpApproval ? 'enabled' : 'disabled'}.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'set_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.operationsChannelId = interaction.options.getChannel('channel').id; saveConfig();
          return interaction.reply({ content: `ARCUS: Ops channel set to <#${gc.operationsChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'set_logs_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.logsChannelId = interaction.options.getChannel('channel').id; saveConfig();
          return interaction.reply({ content: `ARCUS: Logs channel set to <#${gc.logsChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'set_announcement_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.announcementChannelId = interaction.options.getChannel('channel').id; saveConfig();
          return interaction.reply({ content: `ARCUS: Announcements channel set to <#${gc.announcementChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'set_bct_channel') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.bctChannelId = interaction.options.getChannel('channel').id; saveConfig();
          return interaction.reply({ content: `ARCUS: BCT channel set to <#${gc.bctChannelId}>.`, flags: [MessageFlags.Ephemeral] });
        }

        if (sub === 'set_bct_role') {
          if (!isAuthorized(interaction.member, interaction.guildId)) return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
          const gc = getGuildConfig(interaction.guildId);
          gc.bctInstructorRoleId = interaction.options.getRole('role').id; saveConfig();
          return interaction.reply({ content: `ARCUS: BCT instructor role set to <@&${gc.bctInstructorRoleId}>.`, flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op status ───────────────────────────────────────────────────────
      if (group === 'status') {
        if (sub === 'set') {
          const stats = ensureUserStats(data, interaction.user.id);
          stats.availability     = interaction.options.getString('state');
          stats.availabilityNote = interaction.options.getString('note') || '';
          saveData(data);
          return interaction.reply({ content: `ARCUS: Availability set to **${stats.availability}**.`, flags: [MessageFlags.Ephemeral] });
        }
        if (sub === 'view') {
          const target = interaction.options.getUser('target') || interaction.user;
          const stats  = ensureUserStats(data, target.id);
          return interaction.reply({ embeds: [new EmbedBuilder().setTitle(`ARCUS Availability: ${target.username}`).setDescription(`Status: **${stats.availability}**\nNote: ${stats.availabilityNote || '_None_'}`).setColor(0x5865f2)], flags: [MessageFlags.Ephemeral] });
        }
      }

      // ── /op aar ──────────────────────────────────────────────────────────
      if (sub === 'aar') {
        const opId    = interaction.options.getString('id');
        const opEntry = findOpEntryById(data, opId, interaction.guildId);
        if (!opEntry) return interaction.reply({ content: 'ARCUS: Operation not found.', flags: [MessageFlags.Ephemeral] });
        const { key: opKey, op } = opEntry;
        if (interaction.user.id !== op.creatorId && !isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Only the creator or admin can file an AAR.', flags: [MessageFlags.Ephemeral] });
        const modal = new ModalBuilder().setCustomId(`op:modal:aar:${opKey}`).setTitle(`AAR: ${op.name}`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_phases').setLabel('What happened (Phases / Timeline)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('aar_performance').setLabel('Personnel Evaluation').setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        return interaction.showModal(modal);
      }

      // ── /op log ──────────────────────────────────────────────────────────
      if (sub === 'log') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Unauthorized.', flags: [MessageFlags.Ephemeral] });
        const gc = getGuildConfig(interaction.guildId);
        if (!gc.logsChannelId) return interaction.reply({ content: 'ARCUS: Logs channel not configured.', flags: [MessageFlags.Ephemeral] });
        const ch = await interaction.guild.channels.fetch(gc.logsChannelId).catch(() => null);
        if (!ch)  return interaction.reply({ content: 'ARCUS: Logs channel not found.', flags: [MessageFlags.Ephemeral] });
        await ch.send({ embeds: [new EmbedBuilder().setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() }).setDescription(interaction.options.getString('message')).setColor(0x808080).setTimestamp()] });
        return interaction.reply({ content: 'ARCUS: Entry logged.', flags: [MessageFlags.Ephemeral] });
      }

      // ── /op stats ────────────────────────────────────────────────────────
      if (sub === 'stats') {
        await interaction.deferReply(); isDeferred = true;
        const target       = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch({ user: target.id, force: true }).catch(() => null);
        const stats        = ensureUserStats(data, target.id);
        const currentRank  = getRank(targetMember);
        const rankIndex    = ranks.indexOf(currentRank);
        const nextRank     = rankIndex >= 0 && rankIndex < ranks.length - 1 ? ranks[rankIndex + 1] : null;
        const opsToNext    = nextRank && !nextRank.appointed ? `\`${Math.max(0, nextRank.minAttended - stats.attended)}\`` : 'N/A';
        return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`ARCUS Record: ${targetMember?.nickname || target.username}`).setThumbnail(target.displayAvatarURL({ size: 256 })).addFields({ name: 'Rank', value: `**${currentRank.name}**`, inline: true }, { name: 'Ops to Next', value: opsToNext, inline: true }, { name: 'Ops Attended', value: `\`${stats.attended}\``, inline: true }).setColor(0x5865f2)] });
      }

      // ── /op award ────────────────────────────────────────────────────────
      if (sub === 'award') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply(); isDeferred = true;
        const target     = interaction.options.getUser('target');
        const medal      = interaction.options.getString('medal');
        const gc         = getGuildConfig(interaction.guildId);
        const registered = gc.commendations.find(c => c.name.toLowerCase() === medal.toLowerCase());
        const medalName  = registered ? registered.name : medal;
        const emoji      = registered?.emoji ? `${registered.emoji} ` : '';
        const stats      = ensureUserStats(data, target.id);
        stats.medals.push({ name: medalName, date: new Date().toISOString().split('T')[0] });
        saveData(data);
        if (gc.announcementChannelId) {
          const annCh = await interaction.guild.channels.fetch(gc.announcementChannelId).catch(() => null);
          if (annCh) await annCh.send({ embeds: [new EmbedBuilder().setTitle('🎖️ Commendation Issued').setDescription(`${emoji}**${medalName}** awarded to <@${target.id}>.`).setColor(0xFFD700).setTimestamp()] });
        }
        return interaction.editReply({ content: `🎖️ **${medalName}** awarded to <@${target.id}>.` });
      }

      // ── /op revoke ───────────────────────────────────────────────────────
      if (sub === 'revoke') {
        if (!isAuthorized(interaction.member, interaction.guildId))
          return interaction.reply({ content: 'ARCUS: Admin required.', flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply({ ephemeral: true }); isDeferred = true;
        const target    = interaction.options.getUser('target');
        const medalName = interaction.options.getString('medal');
        const stats     = ensureUserStats(data, target.id);
        const before    = stats.medals.length;
        stats.medals    = stats.medals.filter(m => m.name.toLowerCase() !== medalName.toLowerCase());
        if (stats.medals.length === before)
          return interaction.editReply({ content: `ARCUS: **${medalName}** not found on <@${target.id}>'s record.` });
        saveData(data);
        return interaction.editReply({ content: `✅ Revoked **${medalName}** from <@${target.id}>.` });
      }

      // ── /op profile ──────────────────────────────────────────────────────
      if (sub === 'profile') {
        await interaction.deferReply(); isDeferred = true;
        const targetUser   = interaction.options.getUser('target') || interaction.user;
        const targetMember = await interaction.guild.members.fetch({ user: targetUser.id, force: true }).catch(() => null);
        const displayName  = targetMember?.nickname || targetUser.displayName || targetUser.username;
        const stats        = ensureUserStats(data, targetUser.id);
        const currentRank  = getRank(targetMember);
        const rankIndex    = ranks.indexOf(currentRank);
        const nextRank     = rankIndex >= 0 && rankIndex < ranks.length - 1 ? ranks[rankIndex + 1] : null;
        const gc           = getGuildConfig(interaction.guildId);

        let progressText = '*Max Rank Achieved*';
        let opsToNext    = 'N/A';
        if (nextRank) {
          if (nextRank.appointed) {
            progressText = `*Next: ${nextRank.name} (Appointed)*`;
          } else {
            const reqs      = [];
            const opsNeeded = Math.max(0, nextRank.minAttended - stats.attended);
            opsToNext = `\`${opsNeeded}\``;
            if (opsNeeded > 0)                                                 reqs.push(`${opsNeeded} Ops`);
            if (nextRank.requireBCT && !stats.passedBCT)                       reqs.push('BCT');
            if (nextRank.minLed && stats.ledOps < nextRank.minLed)             reqs.push(`${nextRank.minLed - stats.ledOps} Led Ops`);
            if (nextRank.minRecruits && stats.recruits < nextRank.minRecruits) reqs.push(`${nextRank.minRecruits - stats.recruits} Recruits`);
            progressText = `*Next: ${nextRank.name} (${reqs.length > 0 ? reqs.join(', ') : 'Eligible'})*`;
          }
        }

        const councilIdx     = ranks.findIndex(r => r.name === 'Council');
        const isCouncilAbove = rankIndex >= councilIdx;

        const embed = new EmbedBuilder()
          .setTitle(`ARCUS Service Record: ${displayName}`)
          .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: 'Rank',             value: `**${currentRank.name}**`, inline: true },
            { name: 'Ops to Next Rank', value: opsToNext, inline: true },
            { name: 'Personnel Stats',  value: `Attended: \`${stats.attended}\`\
