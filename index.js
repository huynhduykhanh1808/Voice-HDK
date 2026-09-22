'use strict';
require('dotenv').config();

const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField,
  ChannelType
} = require('discord.js');
const { Pool } = require('pg');
const http = require('http');

// ============================================================
// 1) CONFIG
// ============================================================
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const PORT = Number(process.env.PORT || 10000);
const DEFAULT_GENERATOR = process.env.GENERATOR_NAME || '➕・Tạo Phòng';
const FIXED_BLOG_NAME = process.env.BLOG_CHANNEL_NAME || '💬│voice-log';
const ROOM_PREFIX = process.env.ROOM_PREFIX || '🔊・';
const APP_COLOR = 0x5865F2;
const COOLDOWN_MS = 1200;
const BOT_NAME = 'Voice HDK';

if (!TOKEN) throw new Error('Thiếu DISCORD_TOKEN.');
if (!DATABASE_URL) throw new Error('Thiếu DATABASE_URL.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const pool = new Pool({ connectionString: DATABASE_URL });
const cooldowns = new Map();
const panelLocks = new Map();
const pendingTransfers = new Map();
const selectedMembers = new Map(); // channelId -> { ownerId, targetId }
let regionCache = { expires: 0, items: [] };

const REQUIRED_BOT_PERMS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.Connect
];

// Render / UptimeRobot health endpoint. Cố ý rất nhẹ: không gọi DB/Discord API mỗi lần ping.
// UptimeRobot chỉ cần gọi GET https://TEN-SERVICE.onrender.com/health
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }
  const path = String(req.url || '/').split('?')[0];
  if (path !== '/' && path !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, message: 'Không tìm thấy đường dẫn.' }));
  }
  const body = JSON.stringify({ ok: true, discord: client.isReady(), uptime: Math.floor(process.uptime()) });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}).listen(PORT, '0.0.0.0', () => console.log(`[HỆ THỐNG] Health check sẵn sàng tại /health · cổng ${PORT}`));

// ============================================================
// 2) LOGGING / ERROR BOUNDARIES
// ============================================================
function logError(scope, err, context = {}) {
  const names = {
    DISCORD_CLIENT: 'LỖI DISCORD', DISCORD_WARN: 'CẢNH BÁO DISCORD', UNHANDLED_REJECTION: 'LỖI PROMISE',
    UNCAUGHT_EXCEPTION: 'LỖI NGHIÊM TRỌNG', POSTGRES_POOL: 'LỖI CƠ SỞ DỮ LIỆU', STARTUP: 'LỖI KHỞI ĐỘNG',
    LOGIN: 'LỖI ĐĂNG NHẬP', INTERACTION: 'LỖI TƯƠNG TÁC', VOICE_STATE: 'LỖI VOICE',
    PANEL_CREATE_FAILED: 'LỖI BẢNG ĐIỀU KHIỂN', ROOM_DELETE: 'LỖI XÓA PHÒNG'
  };
  const code = err?.code ?? err?.rawError?.code ?? 'KHÔNG_RÕ';
  console.error(`[${names[scope] || scope}] mã=${code}`, context, err?.stack || err);
}

client.on(Events.Error, err => logError('DISCORD_CLIENT', err));
client.on(Events.Warn, info => console.warn('[DISCORD_WARN]', info));
process.on('unhandledRejection', err => logError('UNHANDLED_REJECTION', err));
process.on('uncaughtException', err => {
  // Không nuốt lỗi lập trình nghiêm trọng; log rõ để Render restart sạch.
  logError('UNCAUGHT_EXCEPTION', err);
});
pool.on('error', err => logError('POSTGRES_POOL', err));

// ============================================================
// 3) DATABASE
// ============================================================
async function initDb() {
  await pool.query('SELECT 1');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generators (
      guild_id BIGINT PRIMARY KEY,
      category_id BIGINT NOT NULL,
      generator_id BIGINT NOT NULL,
      blog_channel_id BIGINT,
      tracked_text_channel_id BIGINT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      guild_id BIGINT NOT NULL,
      channel_id BIGINT PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      category_id BIGINT NOT NULL,
      control_message_id BIGINT
    )`);
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS control_message_id BIGINT');
  await pool.query('CREATE INDEX IF NOT EXISTS rooms_guild_owner_idx ON rooms(guild_id, owner_id)');
  console.log('[CƠ SỞ DỮ LIỆU] Đã kết nối PostgreSQL thành công.');
}

async function getGenerator(guildId) {
  const { rows } = await pool.query('SELECT * FROM generators WHERE guild_id=$1', [guildId]);
  return rows[0] || null;
}
async function saveGenerator(guildId, categoryId, generatorId, blogChannelId) {
  await pool.query(`INSERT INTO generators(guild_id,category_id,generator_id,blog_channel_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(guild_id) DO UPDATE SET
    category_id=EXCLUDED.category_id,generator_id=EXCLUDED.generator_id,blog_channel_id=EXCLUDED.blog_channel_id`,
  [guildId, categoryId, generatorId, blogChannelId]);
}
async function updateTrackedChannel(guildId, channelId) {
  await pool.query('UPDATE generators SET tracked_text_channel_id=$1 WHERE guild_id=$2', [channelId, guildId]);
}
async function clearTrackedChannel(guildId) {
  await pool.query('UPDATE generators SET tracked_text_channel_id=NULL WHERE guild_id=$1', [guildId]);
}
async function getRoom(channelId) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE channel_id=$1', [channelId]);
  return rows[0] || null;
}
async function getOwnedRoom(guildId, ownerId) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE guild_id=$1 AND owner_id=$2 ORDER BY channel_id DESC LIMIT 1', [guildId, ownerId]);
  return rows[0] || null;
}
async function saveRoom(guildId, channelId, ownerId, categoryId, controlMessageId = null) {
  await pool.query(`INSERT INTO rooms(guild_id,channel_id,owner_id,category_id,control_message_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id) DO UPDATE SET
    owner_id=EXCLUDED.owner_id, category_id=EXCLUDED.category_id,
    control_message_id=COALESCE(EXCLUDED.control_message_id, rooms.control_message_id)`,
  [guildId, channelId, ownerId, categoryId || 0, controlMessageId]);
}
async function setControlMessage(channelId, messageId) {
  await pool.query('UPDATE rooms SET control_message_id=$1 WHERE channel_id=$2', [messageId, channelId]);
}
async function deleteRoomRecord(channelId) {
  selectedMembers.delete(String(channelId));
  pendingTransfers.delete(String(channelId));
  await pool.query('DELETE FROM rooms WHERE channel_id=$1', [channelId]);
}

// ============================================================
// 4) SMALL HELPERS
// ============================================================
function isSnowflake(v) { return /^\d{17,20}$/.test(String(v || '')); }
function roomState(channel) {
  const everyone = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  return {
    locked: Boolean(everyone?.deny.has(PermissionsBitField.Flags.Connect)),
    hidden: Boolean(everyone?.deny.has(PermissionsBitField.Flags.ViewChannel))
  };
}
function checkCooldown(userId, action) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  if (until > now) return false;
  cooldowns.set(key, now + COOLDOWN_MS);
  return true;
}
function permissionNames(bits) {
  const labels = new Map([
    [PermissionsBitField.Flags.ViewChannel, 'Xem kênh'],
    [PermissionsBitField.Flags.SendMessages, 'Gửi tin nhắn'],
    [PermissionsBitField.Flags.EmbedLinks, 'Nhúng liên kết'],
    [PermissionsBitField.Flags.ReadMessageHistory, 'Đọc lịch sử'],
    [PermissionsBitField.Flags.ManageChannels, 'Quản lý kênh'],
    [PermissionsBitField.Flags.ManageRoles, 'Quản lý quyền'],
    [PermissionsBitField.Flags.MoveMembers, 'Di chuyển thành viên'],
    [PermissionsBitField.Flags.Connect, 'Kết nối voice']
  ]);
  return bits.map(x => labels.get(x) || String(x));
}
function missingBotPermissions(guild, channel = null) {
  const me = guild.members.me;
  if (!me) return REQUIRED_BOT_PERMS;
  const perms = channel ? channel.permissionsFor(me) : me.permissions;
  return REQUIRED_BOT_PERMS.filter(p => !perms?.has(p));
}
async function safeReply(interaction, content, { error = false, ttl = 2800 } = {}) {
  const payload = { content: `${error ? '❌' : '✅'} ${content}`, ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) {
      const msg = await interaction.followUp(payload);
      if (ttl && msg?.id) setTimeout(() => interaction.webhook.deleteMessage(msg.id).catch(() => {}), ttl);
    } else {
      await interaction.reply(payload);
      if (ttl) setTimeout(() => interaction.deleteReply().catch(() => {}), ttl);
    }
  } catch (e) { logError('SAFE_REPLY', e, { customId: interaction.customId }); }
}
async function safeDeferUpdate(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
}
async function sendBlogLog(guild, tag, content) {
  try {
    const gen = await getGenerator(guild.id);
    if (!gen?.blog_channel_id) return;
    const ch = await guild.channels.fetch(String(gen.blog_channel_id)).catch(() => null);
    if (!ch?.isTextBased()) return;
    const clean = String(content).replace(/\s*\n\s*/g, ' ').slice(0, 1500);
    await ch.send({ content: `\`[${tag}]\` <t:${Math.floor(Date.now()/1000)}:t> · ${clean}`, allowedMentions: { parse: [] } });
  } catch (e) { logError('BLOG_LOG', e, { guildId: guild.id, tag }); }
}

// ============================================================
// 5) PERMISSION ENGINE
// Owners do NOT receive ManageChannels/ManageRoles. Bot is the manager.
// This prevents stale-owner privileges and accidental channel deletion.
// ============================================================
async function ensureBotRoomPermissions(channel) {
  const me = channel.guild.members.me;
  if (!me) throw new Error('Không tìm thấy bot member.');
  const missing = missingBotPermissions(channel.guild);
  if (missing.length) throw new Error(`BOT_MISSING_PERMS:${permissionNames(missing).join(', ')}`);
  await channel.permissionOverwrites.edit(me, {
    ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true,
    Connect: true, Speak: true, ManageChannels: true, ManageRoles: true, MoveMembers: true
  }, { reason: 'TempVoice: bảo đảm quyền vận hành của bot' });
}
async function setOwnerAccess(channel, memberOrId, enabled = true) {
  const member = typeof memberOrId === 'string'
    ? await channel.guild.members.fetch(memberOrId).catch(() => null)
    : memberOrId;
  if (!member) return false;
  if (enabled) {
    await channel.permissionOverwrites.edit(member, {
      ViewChannel: true, Connect: true, Speak: true, UseVAD: true
    }, { reason: 'TempVoice: quyền truy cập chủ phòng' });
  } else {
    await channel.permissionOverwrites.delete(member, 'TempVoice: thu hồi quyền chủ cũ').catch(() => {});
  }
  return true;
}
async function transferOwner(channel, newOwner) {
  const room = await getRoom(channel.id);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (String(room.owner_id) === newOwner.id) return;
  const oldOwnerId = String(room.owner_id);
  await ensureBotRoomPermissions(channel);
  await setOwnerAccess(channel, newOwner, true);
  await saveRoom(channel.guild.id, channel.id, newOwner.id, channel.parentId || 0);
  if (oldOwnerId !== newOwner.id) await setOwnerAccess(channel, oldOwnerId, false);
}
async function setRoomLocked(channel, locked) {
  await ensureBotRoomPermissions(channel);
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: locked ? false : null }, { reason: `TempVoice: ${locked ? 'khóa' : 'mở'} phòng` });
}
async function setRoomHidden(channel, hidden) {
  await ensureBotRoomPermissions(channel);
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { ViewChannel: hidden ? false : null }, { reason: `TempVoice: ${hidden ? 'ẩn' : 'hiện'} phòng` });
  const room = await getRoom(channel.id);
  if (room) await setOwnerAccess(channel, String(room.owner_id), true);
}

// ============================================================
// 6) LIVE DISCORD VOICE REGIONS
// Never hard-code region IDs. Discord is the source of truth.
// ============================================================
async function getVoiceRegions({ force = false } = {}) {
  if (!force && regionCache.expires > Date.now() && regionCache.items.length) return regionCache.items;
  try {
    const regions = await client.fetchVoiceRegions();
    const items = [...regions.values()]
      .filter(r => !r.deprecated && !r.custom)
      .sort((a, b) => Number(b.optimal) - Number(a.optimal) || a.name.localeCompare(b.name))
      .slice(0, 24); // Discord select menu: tối đa 25 options, chừa 1 cho Automatic.
    regionCache = { expires: Date.now() + 6 * 60 * 60 * 1000, items };
    return items;
  } catch (e) {
    logError('VOICE_REGIONS', e);
    // Region API không được phép làm chết cả control panel. Automatic luôn hợp lệ (rtcRegion=null).
    return regionCache.items || [];
  }
}
async function regionMenu(channel) {
  const regions = await getVoiceRegions();
  const current = channel.rtcRegion;
  const options = [{
    label: 'Tự động · Discord đề xuất', value: 'auto', emoji: '⚡',
    description: 'Discord tự tối ưu khu vực thoại', default: current === null
  }];
  for (const r of regions) {
    options.push({
      label: r.name.slice(0, 100), value: r.id, emoji: r.optimal ? '✨' : '🌐',
      description: (r.optimal ? 'Khu vực tối ưu · ' : '') + r.id,
      default: current === r.id
    });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('vc_region_select').setPlaceholder('🌐 Khu vực thoại · Tự động').addOptions(options)
  );
}

// ============================================================
// 7) PROFESSIONAL CONTROL PANEL
// ============================================================
async function buildPanel(channel) {
  const room = await getRoom(channel.id);
  if (!room) throw new Error('ROOM_NOT_FOUND');

  const owner = await channel.guild.members.fetch(String(room.owner_id)).catch(() => null);
  const { locked, hidden } = roomState(channel);
  const people = channel.members.filter(m => !m.user.bot).size;
  const limit = channel.userLimit ? `${people} / ${channel.userLimit}` : `${people} / ∞`;
  const region = channel.rtcRegion || 'Tự động';

  const embed = new EmbedBuilder()
    .setColor(APP_COLOR)
    .setTitle(channel.name)
    .setDescription(
      `👑 ${owner ? `<@${owner.id}>` : 'Không xác định'}\n` +
      `👥 ${limit}\n` +
      `${locked ? '🔒 Đã khóa' : '🔓 Đang mở'} · ${hidden ? '🙈 Đang ẩn' : '👁 Đang hiển thị'}\n` +
      `🌐 ${region}`
    );
  if (owner) embed.setThumbnail(owner.user.displayAvatarURL({ size: 128 }));

  // Bố cục cố định đúng 5 Action Rows của Discord.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(locked ? 'vc_unlock' : 'vc_lock').setLabel(locked ? 'Mở phòng' : 'Khóa phòng').setEmoji(locked ? '🔓' : '🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(hidden ? 'vc_unhide' : 'vc_hide').setLabel(hidden ? 'Hiện phòng' : 'Ẩn phòng').setEmoji(hidden ? '👁' : '🙈').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vc_rename').setLabel('Đổi tên phòng').setEmoji('✏️').setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_reset').setLabel('Đặt lại phòng').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vc_limit').setLabel('Giới hạn người').setEmoji('👥').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vc_allow').setLabel('Cấp quyền').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_transfer').setLabel('Chuyển chủ').setEmoji('👑').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vc_deny').setLabel('Cấm thành viên').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('vc_kick').setLabel('Đuổi thành viên').setEmoji('👢').setStyle(ButtonStyle.Danger)
  );

  const selected = selectedMembers.get(channel.id);
  let selectedName = null;
  if (selected && selected.ownerId === String(room.owner_id)) {
    const m = await channel.guild.members.fetch(selected.targetId).catch(() => null);
    if (m && !m.user.bot && m.id !== String(room.owner_id)) selectedName = m.displayName;
    else selectedMembers.delete(channel.id);
  }
  const row4 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('vc_target_select')
      .setPlaceholder((selectedName ? `👤 Đã chọn · ${selectedName}` : '👤 Chọn thành viên').slice(0, 100))
      .setMinValues(1).setMaxValues(1)
  );
  const row5 = await regionMenu(channel);
  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}
function isControlPanelMessage(message) {
  if (message.author?.id !== client.user?.id) return false;
  return message.components?.some(row =>
    row.components?.some(c => c.customId === 'vc_region_select')
  );
}

async function cleanupDuplicatePanels(channel, keepId = null) {
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return;
  const panels = [...recent.values()].filter(isControlPanelMessage);
  for (const m of panels) {
    if (keepId && m.id === keepId) continue;
    await m.delete().catch(() => {});
  }
}

async function refreshPanelUnlocked(channel, preferredMessage = null, { recreate = false } = {}) {
  const room = await getRoom(channel.id);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (!channel?.isVoiceBased()) throw new Error('PANEL_INVALID_CHANNEL');

  await ensureBotRoomPermissions(channel);
  const payload = await buildPanel(channel);

  let msg = (!recreate && preferredMessage && isControlPanelMessage(preferredMessage))
    ? preferredMessage : null;

  if (!msg && !recreate && room.control_message_id) {
    const candidate = await channel.messages.fetch(String(room.control_message_id)).catch(() => null);
    if (candidate && isControlPanelMessage(candidate)) msg = candidate;
  }

  // DB có thể mất message id sau deploy. Tìm panel thật trước khi tạo panel mới.
  if (!msg && !recreate) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) msg = [...recent.values()].find(isControlPanelMessage) || null;
  }

  if (msg) {
    await msg.edit({ ...payload, allowedMentions: { parse: [] } });
    await setControlMessage(channel.id, msg.id);
    await cleanupDuplicatePanels(channel, msg.id);
    return msg;
  }

  if (recreate) await cleanupDuplicatePanels(channel);

  const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } });
  await setControlMessage(channel.id, sent.id);
  await cleanupDuplicatePanels(channel, sent.id);
  console.log(`[BẢNG ĐIỀU KHIỂN] Đã tạo bảng cho phòng ${channel.name} (${channel.id}).`);
  return sent;
}

async function refreshPanel(channel, preferredMessage = null, options = {}) {
  // Mutex theo channel: ngăn VoiceStateUpdate + /panel cùng tạo hai message.
  const previous = panelLocks.get(channel.id) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => refreshPanelUnlocked(channel, preferredMessage, options))
    .catch(e => {
      logError('PANEL_CREATE_FAILED', e, {
        guildId: channel.guild.id,
        channelId: channel.id,
        botPermissions: channel.permissionsFor(channel.guild.members.me)?.toArray?.()
      });
      throw e;
    });

  panelLocks.set(channel.id, current);
  try {
    return await current;
  } finally {
    if (panelLocks.get(channel.id) === current) panelLocks.delete(channel.id);
  }
}

// ============================================================
// 8) SETUP / SELF-DIAGNOSIS / RECONCILE
// ============================================================
async function reconcileGuild(guild) {
  const { rows } = await pool.query('SELECT * FROM rooms WHERE guild_id=$1', [guild.id]);
  for (const room of rows) {
    const channel = await guild.channels.fetch(String(room.channel_id)).catch(() => null);
    if (!channel?.isVoiceBased()) {
      await deleteRoomRecord(String(room.channel_id));
      continue;
    }
    await ensureBotRoomPermissions(channel).catch(e => logError('RECONCILE_PERMS', e, { channelId: channel.id }));
    if (channel.members.size === 0) {
      await deleteRoomRecord(channel.id);
      await channel.delete('TempVoice: dọn phòng trống sau restart').catch(() => {});
    } else {
      await refreshPanel(channel).catch(e => logError('RECONCILE_PANEL', e, { channelId: channel.id }));
    }
  }
}
async function doctorText(guild) {
  const missing = missingBotPermissions(guild);
  const gen = await getGenerator(guild.id);
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
  let regionCount = null;
  try {
    regionCount = (await getVoiceRegions({ force: true })).length;
  } catch (_) {}
  return [
    `**${BOT_NAME} · Kiểm tra hệ thống**`,
    `${dbOk ? '✅' : '❌'} PostgreSQL`,
    `${client.ws.status === 0 ? '✅' : '⚠️'} Discord Gateway`,
    `${missing.length ? '❌' : '✅'} Quyền bot${missing.length ? `: thiếu **${permissionNames(missing).join(', ')}**` : ''}`,
    `${gen ? '✅' : '⚠️'} Temp Voice ${gen ? 'đã setup' : 'chưa chạy /setup'}`,
    `${regionCount !== null ? '✅' : '⚠️'} Voice Regions: ${regionCount !== null ? `${regionCount} vùng khả dụng + Automatic` : 'API tạm không khả dụng · Automatic vẫn dùng được'}`,
    `🧩 Panel: dùng **/panel** khi cần dựng lại bảng điều khiển`
  ].join('\n');
}

// ============================================================
// 9) CREATE / DELETE ROOM
// ============================================================
async function createRoom(guild, member, category) {
  const missing = missingBotPermissions(guild);
  if (missing.length) throw new Error(`BOT_MISSING_PERMS:${permissionNames(missing).join(', ')}`);

  const existing = await getOwnedRoom(guild.id, member.id);
  if (existing) {
    const old = await guild.channels.fetch(String(existing.channel_id)).catch(() => null);
    if (old?.isVoiceBased()) {
      await member.voice.setChannel(old);
      await refreshPanel(old).catch(() => {});
      return old;
    }
    await deleteRoomRecord(String(existing.channel_id));
  }

  const me = guild.members.me;
  const channel = await guild.channels.create({
    name: `${ROOM_PREFIX}Phòng của ${member.displayName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: category?.id || null,
    rtcRegion: null,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.UseVAD] },
      { id: me.id, allow: REQUIRED_BOT_PERMS.concat([PermissionsBitField.Flags.Speak]) },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.UseVAD] }
    ]
  });
  await saveRoom(guild.id, channel.id, member.id, category?.id || 0);
  await member.voice.setChannel(channel);
  // Panel là UI, không được phép làm hỏng luồng tạo phòng. Thử lại một lần sau khi Discord hoàn tất channel state.
  try {
    await refreshPanel(channel);
  } catch (firstError) {
    logError('PANEL_CREATE_RETRY', firstError, { guildId: guild.id, channelId: channel.id });
    await new Promise(resolve => setTimeout(resolve, 900));
    await refreshPanel(channel).catch(e => logError('PANEL_CREATE_GIVEUP', e, { guildId: guild.id, channelId: channel.id }));
  }
  await sendBlogLog(guild, 'TẠO PHÒNG', `${member.user.tag} → ${channel.name}`);
  return channel;
}

// ============================================================
// 10) READY + COMMANDS
// ============================================================
client.once(Events.ClientReady, async readyClient => {
  try {
    await initDb();
    readyClient.user.setActivity(`${BOT_NAME} · /panel`);
    await readyClient.application.commands.set([
      { name: 'setup', description: '[Admin] Cài đặt hệ thống Temp Voice', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'doctor', description: '[Admin] Kiểm tra DB, quyền và trạng thái bot', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'panel', description: 'Dựng lại bảng điều khiển cho phòng Temp Voice hiện tại' },
      { name: 'track-channel', description: '[Admin] Theo dõi log chat của kênh hiện tại', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'untrack-channel', description: '[Admin] Dừng theo dõi kênh chat', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() }
    ]);
    console.log(`[DISCORD] Đăng nhập thành công: ${readyClient.user.tag}`);
    console.log('[LỆNH] Đã đồng bộ Slash Commands thành công.');
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const me = guild.members.me || await guild.members.fetchMe();
        if (me?.manageable && me.displayName !== BOT_NAME) await me.setNickname(BOT_NAME, 'Đồng bộ tên hiển thị bot');
      } catch (e) {
        console.warn(`[CẢNH BÁO] Không thể đặt biệt danh bot thành ${BOT_NAME} tại server ${guild.name}: ${e?.message || e}`);
      }
      await reconcileGuild(guild).catch(e => logError('RECONCILE', e, { guildId: guild.id }));
    }
  } catch (e) {
    logError('STARTUP', e);
    // DB là thành phần bắt buộc. Thoát để Render restart thay vì online giả.
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500);
  }
});

// ============================================================
// 11) VOICE STATE
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    const gen = await getGenerator(member.guild.id);

    if (newState.channelId && newState.channelId !== oldState.channelId && gen?.generator_id && newState.channelId === String(gen.generator_id)) {
      await createRoom(member.guild, member, newState.channel?.parent);
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      if (gen?.generator_id && oldState.channelId === String(gen.generator_id)) return;
      const room = await getRoom(oldState.channelId);
      const channel = oldState.channel;
      if (!room || !channel) return;
      if (channel.members.size === 0) {
        await deleteRoomRecord(channel.id);
        await channel.delete('TempVoice: phòng trống').catch(e => logError('ROOM_DELETE', e, { channelId: channel.id }));
        await sendBlogLog(member.guild, 'XÓA PHÒNG', channel.name);
      } else {
        await refreshPanel(channel).catch(() => {});
      }
    }

    if (newState.channelId && newState.channelId !== oldState.channelId) {
      const room = await getRoom(newState.channelId);
      if (room && newState.channel) await refreshPanel(newState.channel).catch(() => {});
    }
  } catch (e) { logError('VOICE_STATE', e, { old: oldState.channelId, next: newState.channelId }); }
});

// ============================================================
// 12) NHẬT KÝ CHAT / BẰNG CHỨNG
// - Tin chữ bình thường: Tên » "nội dung" • HH:mm:ss dd/MM/yyyy
// - Có link/tệp: xuống dòng chi tiết, thời gian luôn ở dòng cuối.
// - Tệp được tải ngay và gửi lại vào kênh blog khi có thể, để tin gốc bị xóa
//   vẫn còn bản sao phục vụ quản trị.
// ============================================================
const LOG_ATTACHMENT_MAX_BYTES = 24 * 1024 * 1024; // giới hạn an toàn phía bot; Discord vẫn có thể áp giới hạn thấp hơn.

function vietnamTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(date);
  const get = type => parts.find(x => x.type === type)?.value || '';
  return `${get('hour')}:${get('minute')}:${get('second')} ${get('day')}/${get('month')}/${get('year')}`;
}
function extractLinks(text = '') {
  return [...new Set(String(text).match(/https?:\/\/[^\s<>]+/gi) || [])];
}
function stripLinks(text = '') {
  return String(text).replace(/https?:\/\/[^\s<>]+/gi, '').replace(/\s+/g, ' ').trim();
}
function safeFileName(name = 'tep-dinh-kem') {
  return String(name).replace(/[\\/\0\r\n]/g, '_').slice(0, 180) || 'tep-dinh-kem';
}
async function downloadAttachment(att) {
  if (!att?.url) return null;
  if (Number(att.size || 0) > LOG_ATTACHMENT_MAX_BYTES) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(att.url, { signal: controller.signal });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > LOG_ATTACHMENT_MAX_BYTES) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > LOG_ATTACHMENT_MAX_BYTES) return null;
    return Buffer.from(arrayBuffer);
  } finally { clearTimeout(timer); }
}
async function getBlogChannel(guild) {
  const gen = await getGenerator(guild.id);
  if (!gen?.blog_channel_id) return null;
  const channel = await guild.channels.fetch(String(gen.blog_channel_id)).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}
async function shouldLogChatMessage(message) {
  const room = await getRoom(message.channel.id);
  if (room) return true;
  const gen = await getGenerator(message.guild.id);
  return Boolean(gen?.tracked_text_channel_id && message.channel.id === String(gen.tracked_text_channel_id));
}
async function logChatEvidence(message, action = 'GỬI') {
  if (!message?.guild || !message.author || message.author.bot) return;
  if (!(await shouldLogChatMessage(message))) return;
  const blog = await getBlogChannel(message.guild);
  if (!blog || blog.id === message.channel.id) return; // chống vòng lặp nếu admin cấu hình nhầm.

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const displayName = (member?.displayName || message.author.globalName || message.author.username || 'Không rõ').replace(/[\r\n]/g, ' ').slice(0, 80);
  const raw = String(message.content || '').trim();
  const links = extractLinks(raw);
  const textOnly = stripLinks(raw);
  const attachments = [...message.attachments.values()];
  const time = vietnamTime(message.createdAt || new Date());
  const prefix = action === 'GỬI' ? `${displayName} »` : `${displayName} » [${action}]`;
  const lines = [];

  if (!links.length && !attachments.length) {
    const body = (textOnly || '[Không có nội dung]').replace(/\s+/g, ' ').slice(0, 1500);
    lines.push(`${prefix} "${body.replace(/"/g, '”')}" • ${time}`);
  } else {
    if (textOnly) lines.push(`${prefix} "${textOnly.replace(/\s+/g, ' ').slice(0, 1300).replace(/"/g, '”')}"`);
    else lines.push(prefix);
    if (links.length) lines.push(`🔗 Liên kết: ${links.join(' • ').slice(0, 1600)}`);
    if (attachments.length) lines.push(`📎 Tệp đính kèm: ${attachments.map(a => safeFileName(a.name)).join(' • ').slice(0, 1500)}`);
    lines.push(time); // ngày giờ luôn ở cuối cùng theo yêu cầu.
  }

  const files = [];
  const failed = [];
  for (const att of attachments) {
    try {
      const buffer = await downloadAttachment(att);
      if (buffer) files.push({ attachment: buffer, name: safeFileName(att.name) });
      else failed.push(att);
    } catch (e) {
      failed.push(att);
      logError('BLOG_ATTACHMENT', e, { guildId: message.guild.id, messageId: message.id, attachment: att.name });
    }
  }
  if (failed.length) {
    const fallback = failed.map(a => `${safeFileName(a.name)}: ${a.url}`).join('\n');
    lines.splice(lines.length - 1, 0, `⚠️ Không thể sao lưu trực tiếp: ${fallback}`.slice(0, 1700));
  }

  const payload = { content: lines.join('\n').slice(0, 1950), allowedMentions: { parse: [] } };
  if (files.length) payload.files = files;
  try {
    await blog.send(payload);
  } catch (firstError) {
    // Nếu Discord từ chối upload (thường do tổng dung lượng), vẫn phải ghi lại metadata + URL.
    if (files.length) {
      const fallbackLinks = attachments.map(a => `${safeFileName(a.name)}: ${a.url}`).join('\n');
      const fallbackText = `${lines.join('\n')}\n⚠️ Discord không nhận bản sao tệp. URL gốc:\n${fallbackLinks}`.slice(0, 1950);
      await blog.send({ content: fallbackText, allowedMentions: { parse: [] } });
    } else throw firstError;
  }
}

client.on(Events.MessageCreate, async message => {
  try { await logChatEvidence(message, 'GỬI'); }
  catch (e) { logError('MESSAGE_LOG', e, { event: 'create', messageId: message.id }); }
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (!newMessage.guild || newMessage.author?.bot) return;
    // Discord có thể phát update chỉ vì embed/link preview thay đổi; chỉ log khi nội dung thực sự đổi.
    if (oldMessage.content === newMessage.content) return;
    await logChatEvidence(newMessage, 'ĐÃ SỬA');
  } catch (e) { logError('MESSAGE_LOG', e, { event: 'update', messageId: newMessage.id }); }
});

client.on(Events.MessageDelete, async message => {
  try {
    if (!message.guild || message.author?.bot || !message.author) return;
    if (!(await shouldLogChatMessage(message))) return;
    const blog = await getBlogChannel(message.guild);
    if (!blog || blog.id === message.channel.id) return;
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const name = (member?.displayName || message.author.globalName || message.author.username || 'Không rõ').replace(/[\r\n]/g, ' ').slice(0, 80);
    const preview = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    await blog.send({
      content: `${name} » [ĐÃ XÓA]${preview ? ` "${preview.replace(/"/g, '”')}"` : ''} • ${vietnamTime(new Date())}`,
      allowedMentions: { parse: [] }
    });
  } catch (e) { logError('MESSAGE_LOG', e, { event: 'delete', messageId: message.id }); }
});

// ============================================================
// 13) INTERACTIONS
// ============================================================
async function requireRoomInteraction(interaction, ownerOnly = true) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error('USER_NOT_IN_VOICE');
  const room = await getRoom(channel.id);
  if (!room) throw new Error('NOT_TEMP_ROOM');
  if (interaction.channelId && interaction.channelId !== channel.id) throw new Error('WRONG_ROOM');
  if (ownerOnly && String(room.owner_id) !== interaction.user.id) throw new Error('NOT_OWNER');
  return { channel, room };
}
function friendlyError(err) {
  const msg = String(err?.message || err);
  if (msg === 'USER_NOT_IN_VOICE') return 'Bạn cần ở trong phòng thoại của mình.';
  if (msg === 'NOT_TEMP_ROOM') return 'Đây không phải phòng thoại tạm do bot quản lý.';
  if (msg === 'NOT_OWNER') return 'Chỉ chủ phòng mới dùng được chức năng này.';
  if (msg === 'WRONG_ROOM') return 'Bạn phải đang ở đúng phòng thoại của bảng điều khiển này.';
  if (msg === 'ROOM_NOT_FOUND') return 'Không tìm thấy dữ liệu phòng. Hãy vào lại kênh tạo phòng.';
  if (msg.startsWith('BOT_MISSING_PERMS:')) return `Bot đang thiếu quyền: **${msg.split(':').slice(1).join(':')}**. Admin hãy chạy /doctor.`;
  if (err?.code === 50013) return 'Bot thiếu quyền Discord để thực hiện thao tác này. Admin hãy chạy /doctor.';
  if (err?.code === 10003 || err?.code === 10008) return 'Phòng hoặc bảng điều khiển không còn tồn tại.';
  return 'Không thể hoàn tất thao tác. Bot đã ghi log kỹ thuật để kiểm tra.';
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.guild) return;
  try {
    // ----- Slash commands -----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'doctor') return interaction.reply({ content: await doctorText(interaction.guild), ephemeral: true });
      if (interaction.commandName === 'panel') {
        const { channel, room } = await requireRoomInteraction(interaction, false);
        const isOwner = String(room.owner_id) === interaction.user.id;
        const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
        if (!isOwner && !isAdmin) return safeReply(interaction, 'Chỉ chủ phòng hoặc quản trị viên mới có thể dựng lại bảng điều khiển.', { error: true });
        await interaction.deferReply({ ephemeral: true });
        const msg = await refreshPanel(channel, null, { recreate: true });
        await interaction.editReply({ content: `✅ Bảng điều khiển đã được dựng lại trong <#${channel.id}>.` });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 3500);
        return msg;
      }
      if (interaction.commandName === 'track-channel') {
        if (!interaction.channel?.isTextBased()) return safeReply(interaction, 'Lệnh này chỉ dùng trong kênh văn bản.', { error: true });
        await updateTrackedChannel(interaction.guild.id, interaction.channel.id);
        return safeReply(interaction, 'Đã bật theo dõi kênh hiện tại.');
      }
      if (interaction.commandName === 'untrack-channel') {
        await clearTrackedChannel(interaction.guild.id);
        return safeReply(interaction, 'Đã tắt theo dõi kênh.');
      }
      if (interaction.commandName === 'setup') {
        const missing = missingBotPermissions(interaction.guild);
        if (missing.length) return interaction.reply({ content: `❌ Bot chưa đủ quyền để vận hành ổn định:\n**${permissionNames(missing).join(', ')}**\n\nHãy cấp các quyền này cho role bot rồi chạy /setup lại.`, ephemeral: true });
        const cats = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).first(25);
        if (!cats.length) return safeReply(interaction, 'Server chưa có Category.', { error: true });
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
          .setCustomId('setup_category_select').setPlaceholder('📁 Chọn danh mục cho Temp Voice')
          .addOptions(cats.map(c => ({ label: c.name.slice(0, 100), value: c.id, emoji: '📁' }))));
        return interaction.reply({ content: '**Thiết lập Voice Control** · Chọn danh mục:', components: [row], ephemeral: true });
      }
      return;
    }

    // ----- Setup + region selects -----
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'setup_category_select') {
        await interaction.deferUpdate();
        const category = await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
        if (!category || category.type !== ChannelType.GuildCategory) throw new Error('Category không hợp lệ');
        let generator = category.children.cache.find(c => c.name === DEFAULT_GENERATOR && c.type === ChannelType.GuildVoice);
        if (!generator) generator = await interaction.guild.channels.create({ name: DEFAULT_GENERATOR, type: ChannelType.GuildVoice, parent: category.id });
        let blog = category.children.cache.find(c => c.name === FIXED_BLOG_NAME && c.type === ChannelType.GuildText);
        if (!blog) blog = await interaction.guild.channels.create({ name: FIXED_BLOG_NAME, type: ChannelType.GuildText, parent: category.id });
        await saveGenerator(interaction.guild.id, category.id, generator.id, blog.id);
        await interaction.editReply({ content: `✅ **Cài đặt hoàn tất**\n🔊 Tạo phòng: ${generator}\n🧾 Nhật ký: ${blog}`, components: [] });
        return;
      }
      if (interaction.customId === 'vc_region_select') {
        const { channel } = await requireRoomInteraction(interaction, true);
        if (!checkCooldown(interaction.user.id, 'region')) return safeReply(interaction, 'Thao tác quá nhanh, thử lại sau một giây.', { error: true, ttl: 1600 });
        await safeDeferUpdate(interaction);
        const selected = interaction.values[0];
        let target = null;
        if (selected !== 'auto') {
          const regions = await getVoiceRegions();
          const valid = regions.find(r => r.id === selected && !r.deprecated && !r.custom);
          if (!valid) throw new Error('REGION_INVALID');
          target = valid.id;
        }
        await channel.setRTCRegion(target, `TempVoice: ${interaction.user.tag}`);
        await channel.fetch(true);
        await refreshPanel(channel, interaction.message);
        await sendBlogLog(interaction.guild, 'KHU VỰC', `${interaction.user.tag} → ${target || 'Automatic'}`);
        return safeReply(interaction, `Khu vực thoại: **${target || 'Tự động'}**.`);
      }
    }

    // ----- Chọn thành viên trực tiếp trên panel -----
    if (interaction.isUserSelectMenu() && interaction.customId === 'vc_target_select') {
      const { channel, room } = await requireRoomInteraction(interaction, true);
      const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
      if (!target || target.user.bot) return safeReply(interaction, 'Thành viên không hợp lệ.', { error: true });
      if (target.id === interaction.user.id) return safeReply(interaction, 'Bạn đang là chủ phòng, hãy chọn thành viên khác.', { error: true });
      selectedMembers.set(channel.id, { ownerId: String(room.owner_id), targetId: target.id });
      await safeDeferUpdate(interaction);
      await refreshPanel(channel, interaction.message);
      console.log(`[THÀNH VIÊN] ${interaction.user.tag} đã chọn ${target.user.tag} trong ${channel.name}.`);
      return;
    }

    // ----- Buttons -----
    if (interaction.isButton()) {
      const { channel, room } = await requireRoomInteraction(interaction, false);
      const owner = String(room.owner_id) === interaction.user.id;

      if (interaction.customId.startsWith('vc_accept_transfer:') || interaction.customId.startsWith('vc_decline_transfer:')) {
        const targetId = interaction.customId.split(':')[1];
        const pending = pendingTransfers.get(channel.id);

        if (interaction.user.id !== targetId) return safeReply(interaction, 'Yêu cầu này không dành cho bạn.', { error: true });
        if (!pending || pending.toId !== targetId || pending.expiresAt < Date.now()) {
          pendingTransfers.delete(channel.id);
          return interaction.update({ content: '⌛ Yêu cầu chuyển chủ đã hết hạn.', components: [] });
        }
        if (interaction.customId.startsWith('vc_decline_transfer:')) {
          pendingTransfers.delete(channel.id);
          return interaction.update({
            content: `↩️ <@${interaction.user.id}> đã từ chối nhận quyền chủ phòng.`,
            components: [],
            allowedMentions: { users: [interaction.user.id] }
          });
        }
        if (interaction.member.voice.channelId !== channel.id) {
          return safeReply(interaction, 'Bạn phải đang ở trong phòng để nhận quyền.', { error: true });
        }
        const latest = await getRoom(channel.id);
        if (!latest || String(latest.owner_id) !== pending.fromId) {
          pendingTransfers.delete(channel.id);
          return interaction.update({ content: '⌛ Quyền chủ phòng đã thay đổi. Yêu cầu này không còn hiệu lực.', components: [] });
        }

        await transferOwner(channel, interaction.member);
        pendingTransfers.delete(channel.id);
        selectedMembers.delete(channel.id);
        await refreshPanel(channel);
        await interaction.update({
          content: `👑 <@${interaction.user.id}> đã nhận quyền chủ phòng.`,
          components: [],
          allowedMentions: { users: [interaction.user.id] }
        });
        await sendBlogLog(interaction.guild, 'CHUYỂN CHỦ', `${pending.fromId} → ${interaction.user.tag}`);
        return;
      }

      if (!owner) {
        return safeReply(interaction, 'Chức năng này dành cho chủ phòng.', { error: true });
      }
      if (!checkCooldown(interaction.user.id, interaction.customId)) return safeReply(interaction, 'Thao tác quá nhanh.', { error: true, ttl: 1500 });

      if (['vc_lock','vc_unlock','vc_hide','vc_unhide'].includes(interaction.customId)) await safeDeferUpdate(interaction);
      if (interaction.customId === 'vc_lock') { await setRoomLocked(channel, true); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'KHÓA',interaction.user.tag); return safeReply(interaction,'Đã khóa phòng.'); }
      if (interaction.customId === 'vc_unlock') { await setRoomLocked(channel, false); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'MỞ',interaction.user.tag); return safeReply(interaction,'Đã mở phòng.'); }
      if (interaction.customId === 'vc_hide') { await setRoomHidden(channel, true); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'ẨN',interaction.user.tag); return safeReply(interaction,'Đã ẩn phòng.'); }
      if (interaction.customId === 'vc_unhide') { await setRoomHidden(channel, false); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'HIỆN',interaction.user.tag); return safeReply(interaction,'Đã hiện phòng.'); }
      if (interaction.customId === 'vc_reset') {
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('vc_reset_confirm').setLabel('Xác nhận đặt lại').setEmoji('♻️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('vc_reset_cancel').setLabel('Hủy').setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: '♻️ Đặt lại sẽ mở/hiện phòng, bỏ giới hạn, đưa khu vực về Tự động và xóa quyền riêng của thành viên.', components: [confirmRow], ephemeral: true });
      }
      if (interaction.customId === 'vc_reset_cancel') {
        return interaction.update({ content: 'Đã hủy đặt lại phòng.', components: [] });
      }
      if (interaction.customId === 'vc_reset_confirm') {
        await interaction.deferUpdate();
        await setRoomLocked(channel, false); await setRoomHidden(channel, false); await channel.setUserLimit(0); await channel.setRTCRegion(null);
        for (const ow of [...channel.permissionOverwrites.cache.values()]) {
          if (ow.id !== channel.guild.roles.everyone.id && ow.id !== channel.guild.members.me.id && ow.id !== String(room.owner_id)) {
            await ow.delete('TempVoice: đặt lại phòng');
          }
        }
        await setOwnerAccess(channel, String(room.owner_id), true);
        selectedMembers.delete(channel.id);
        await refreshPanel(channel); await sendBlogLog(interaction.guild,'ĐẶT LẠI',interaction.user.tag);
        console.log(`[ĐẶT LẠI] ${interaction.user.tag} đã đặt lại ${channel.name}.`);
        return interaction.editReply({ content: '✅ Đã đưa phòng về cấu hình mặc định.', components: [] });
      }

      const needsTarget = ['vc_allow','vc_deny','vc_kick','vc_transfer'].includes(interaction.customId);
      if (needsTarget) {
        const selected = selectedMembers.get(channel.id);
        if (!selected || selected.ownerId !== interaction.user.id) return safeReply(interaction, 'Hãy chọn thành viên ở ô 👤 trước.', { error: true });
        const target = await interaction.guild.members.fetch(selected.targetId).catch(() => null);
        if (!target || target.user.bot || target.id === interaction.user.id) {
          selectedMembers.delete(channel.id);
          await refreshPanel(channel, interaction.message).catch(() => {});
          return safeReply(interaction, 'Thành viên đã chọn không còn hợp lệ. Hãy chọn lại.', { error: true });
        }
        await ensureBotRoomPermissions(channel);

        if (interaction.customId === 'vc_allow') {
          await interaction.deferReply({ ephemeral: true });
          await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true }, { reason: `TempVoice: cấp quyền bởi ${interaction.user.tag}` });
          await interaction.editReply(`✅ Đã cấp quyền cho **${target.displayName}**.`);
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2500);
          await sendBlogLog(interaction.guild, 'CẤP QUYỀN', `${interaction.user.tag} → ${target.user.tag}`);
          console.log(`[CẤP QUYỀN] ${interaction.user.tag} → ${target.user.tag} | ${channel.name}`);
          return;
        }
        if (interaction.customId === 'vc_deny') {
          await interaction.deferReply({ ephemeral: true });
          await channel.permissionOverwrites.edit(target.id, { ViewChannel: null, Connect: false }, { reason: `TempVoice: cấm bởi ${interaction.user.tag}` });
          if (target.voice.channelId === channel.id) await target.voice.disconnect('TempVoice: bị chủ phòng cấm');
          await interaction.editReply(`⛔ Đã cấm **${target.displayName}** khỏi phòng.`);
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2500);
          await sendBlogLog(interaction.guild, 'CẤM', `${interaction.user.tag} → ${target.user.tag}`);
          console.log(`[CẤM] ${interaction.user.tag} → ${target.user.tag} | ${channel.name}`);
          await refreshPanel(channel);
          return;
        }
        if (interaction.customId === 'vc_kick') {
          if (target.voice.channelId !== channel.id) return safeReply(interaction, 'Thành viên đã chọn không còn ở trong phòng.', { error: true });
          await interaction.deferReply({ ephemeral: true });
          await target.voice.disconnect('TempVoice: chủ phòng mời rời');
          await interaction.editReply(`👢 Đã đuổi **${target.displayName}** khỏi phòng.`);
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2500);
          await sendBlogLog(interaction.guild, 'ĐUỔI', `${interaction.user.tag} → ${target.user.tag}`);
          console.log(`[ĐUỔI] ${interaction.user.tag} → ${target.user.tag} | ${channel.name}`);
          await refreshPanel(channel);
          return;
        }
        if (interaction.customId === 'vc_transfer') {
          if (target.voice.channelId !== channel.id) return safeReply(interaction, 'Người nhận phải đang ở trong phòng.', { error: true });
          const expiresAt = Date.now() + 60_000;
          pendingTransfers.set(channel.id, { fromId: interaction.user.id, toId: target.id, expiresAt });
          const transferRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`vc_accept_transfer:${target.id}`).setLabel('Nhận phòng').setEmoji('👑').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`vc_decline_transfer:${target.id}`).setLabel('Từ chối').setStyle(ButtonStyle.Secondary)
          );
          await interaction.deferReply({ ephemeral: true });
          await channel.send({
            content: `👑 <@${interaction.user.id}> muốn chuyển quyền chủ phòng cho <@${target.id}>.`,
            components: [transferRow], allowedMentions: { users: [interaction.user.id, target.id] }
          });
          await interaction.editReply(`✅ Đã gửi yêu cầu chuyển chủ cho **${target.displayName}**.`);
          setTimeout(() => interaction.deleteReply().catch(() => {}), 2500);
          console.log(`[CHUYỂN CHỦ] Đang chờ xác nhận: ${interaction.user.tag} → ${target.user.tag} | ${channel.name}`);
          return;
        }
      }

      if (interaction.customId === 'vc_rename') {
        const modal = new ModalBuilder().setCustomId('vc_modal_rename').setTitle('Đổi tên phòng');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Tên mới').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(70).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'vc_limit') {
        const modal = new ModalBuilder().setCustomId('vc_modal_limit').setTitle('Giới hạn thành viên');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('0 = không giới hạn · tối đa 99').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true).setPlaceholder('0')));
        return interaction.showModal(modal);
      }
      return;
    }

    // ----- Modals -----
    if (interaction.isModalSubmit()) {
      const { channel } = await requireRoomInteraction(interaction, true);
      if (interaction.customId === 'vc_modal_rename') {
        const raw = interaction.fields.getTextInputValue('name').trim().replace(/[\r\n\t]/g, ' ');
        if (!raw) throw new Error('Tên phòng trống');
        await channel.setName(`${ROOM_PREFIX}${raw}`.slice(0, 100), `TempVoice rename by ${interaction.user.tag}`);
        await refreshPanel(channel);
        await sendBlogLog(interaction.guild, 'ĐỔI TÊN', `${interaction.user.tag} → ${raw}`);
        return safeReply(interaction, `Đã đổi tên thành **${raw}**.`);
      }
      if (interaction.customId === 'vc_modal_limit') {
        const value = Number(interaction.fields.getTextInputValue('limit').trim());
        if (!Number.isInteger(value) || value < 0 || value > 99) return safeReply(interaction, 'Giới hạn phải là số từ 0 đến 99.', { error: true });
        await channel.setUserLimit(value, `TempVoice limit by ${interaction.user.tag}`);
        await refreshPanel(channel);
        await sendBlogLog(interaction.guild, 'GIỚI HẠN', `${interaction.user.tag} → ${value || '∞'}`);
        return safeReply(interaction, value ? `Giới hạn: **${value} người**.` : 'Đã bỏ giới hạn thành viên.');
      }
    }
  } catch (err) {
    logError('INTERACTION', err, { guildId: interaction.guildId, userId: interaction.user?.id, customId: interaction.customId, command: interaction.commandName });
    try { await safeReply(interaction, friendlyError(err), { error: true, ttl: 4500 }); } catch (_) {}
  }
});

// ============================================================
// 14) LOGIN / GRACEFUL SHUTDOWN
// ============================================================
async function shutdown(signal) {
  console.log(`[HỆ THỐNG] Đang tắt bot (${signal}).`);
  try { await client.destroy(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

console.log(`[HỆ THỐNG] Đang khởi động ${BOT_NAME}...`);
client.login(TOKEN).catch(err => {
  logError('LOGIN', err);
  process.exit(1);
});


// ============================================================
// 15) UPTIMEROBOT / RENDER FREE - GHI CHÚ CẤU HÌNH CUỐI FILE
// ============================================================
// Không cần nhập API key UptimeRobot vào bot và bot KHÔNG tự ping chính nó.
// Sau khi deploy Render, lấy URL public của Web Service rồi tạo HTTP(s) Monitor:
//   URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
//   Method: GET
// Endpoint /health ở đầu file luôn trả HTTP 200 khi tiến trình Node đang chạy.
// Nếu sau này đổi tên/domain Render, chỉ sửa URL bên UptimeRobot; không cần sửa logic bot.
