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

// Render health endpoint. Không chứa logic bot.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, ready: client.isReady(), uptime: Math.floor(process.uptime()) }));
}).listen(PORT, () => console.log(`[WEB] Health server :${PORT}`));

// ============================================================
// 2) LOGGING / ERROR BOUNDARIES
// ============================================================
function logError(scope, err, context = {}) {
  const code = err?.code ?? err?.rawError?.code ?? 'UNKNOWN';
  console.error(`[${scope}] code=${code}`, context, err?.stack || err);
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
  console.log('[DB] PostgreSQL ready');
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
async function getVoiceRegions() {
  if (regionCache.expires > Date.now() && regionCache.items.length) return regionCache.items;
  const regions = await client.fetchVoiceRegions();
  const items = [...regions.values()]
    .filter(r => !r.deprecated && !r.custom)
    .sort((a, b) => Number(b.optimal) - Number(a.optimal) || a.name.localeCompare(b.name))
    .slice(0, 24);
  regionCache = { expires: Date.now() + 6 * 60 * 60 * 1000, items };
  return items;
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
  const limit = channel.userLimit ? `${channel.members.size}/${channel.userLimit}` : `${channel.members.size}/∞`;
  const region = channel.rtcRegion ? channel.rtcRegion : 'Tự động';
  const ownerText = owner ? `<@${owner.id}>` : '`Không xác định`';

  const embed = new EmbedBuilder()
    .setColor(APP_COLOR)
    .setTitle(`🔊 ${channel.name.replace(/^🔊[・\s-]*/, '')}`)
    .setDescription(
      `👑 ${ownerText}\n` +
      `👥 **${limit}**  ·  ${locked ? '🔒 Đã khóa' : '🔓 Đang mở'}  ·  ${hidden ? '🙈 Đang ẩn' : '👁️ Hiển thị'}\n` +
      `🌐 **${region}**\n\n` +
      `*Không gian riêng · Giao lưu vui vẻ và tôn trọng nhau.*`
    )
    .setFooter({ text: 'Voice Control · Trạng thái được đồng bộ trực tiếp từ Discord' });
  if (owner) embed.setThumbnail(owner.user.displayAvatarURL({ size: 128 }));

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(locked ? 'vc_unlock' : 'vc_lock').setLabel(locked ? 'Mở phòng' : 'Khóa phòng').setEmoji(locked ? '🔓' : '🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(hidden ? 'vc_unhide' : 'vc_hide').setLabel(hidden ? 'Hiện phòng' : 'Ẩn phòng').setEmoji(hidden ? '👁️' : '🙈').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vc_rename').setLabel('Đổi tên').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('vc_limit').setLabel('Giới hạn').setEmoji('👥').setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_allow').setLabel('Cho phép').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vc_deny').setLabel('Cấm').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('vc_kick').setLabel('Đuổi').setEmoji('👢').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('vc_transfer').setLabel('Chuyển chủ').setEmoji('👑').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vc_reset').setLabel('Đặt lại').setEmoji('↺').setStyle(ButtonStyle.Secondary)
  );
  const row3 = await regionMenu(channel);
  return { embeds: [embed], components: [row1, row2, row3] };
}
async function refreshPanel(channel, preferredMessage = null) {
  const room = await getRoom(channel.id);
  if (!room) return;
  const payload = await buildPanel(channel);
  let msg = preferredMessage;
  if (!msg && room.control_message_id) msg = await channel.messages.fetch(String(room.control_message_id)).catch(() => null);
  if (msg) {
    await msg.edit(payload).catch(e => logError('PANEL_EDIT', e, { channelId: channel.id }));
    return msg;
  }
  const sent = await channel.send(payload);
  await setControlMessage(channel.id, sent.id);
  return sent;
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
  return [
    `**Voice Bot · Kiểm tra hệ thống**`,
    `${dbOk ? '✅' : '❌'} PostgreSQL`,
    `${client.ws.status === 0 ? '✅' : '⚠️'} Discord Gateway`,
    `${missing.length ? '❌' : '✅'} Quyền bot${missing.length ? `: thiếu **${permissionNames(missing).join(', ')}**` : ''}`,
    `${gen ? '✅' : '⚠️'} Temp Voice ${gen ? 'đã setup' : 'chưa chạy /setup'}`,
    `🌐 Voice regions: lấy trực tiếp từ Discord API`
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
  await refreshPanel(channel);
  await sendBlogLog(guild, 'TẠO PHÒNG', `${member.user.tag} → ${channel.name}`);
  return channel;
}

// ============================================================
// 10) READY + COMMANDS
// ============================================================
client.once(Events.ClientReady, async readyClient => {
  try {
    await initDb();
    readyClient.user.setActivity('Voice Control · /setup');
    await readyClient.application.commands.set([
      { name: 'setup', description: '[Admin] Cài đặt hệ thống Temp Voice', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'doctor', description: '[Admin] Kiểm tra DB, quyền và trạng thái bot', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'track-channel', description: '[Admin] Theo dõi log chat của kênh hiện tại', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() },
      { name: 'untrack-channel', description: '[Admin] Dừng theo dõi kênh chat', defaultMemberPermissions: PermissionsBitField.Flags.Administrator.toString() }
    ]);
    console.log(`[READY] ${readyClient.user.tag}`);
    for (const guild of readyClient.guilds.cache.values()) await reconcileGuild(guild).catch(e => logError('RECONCILE', e, { guildId: guild.id }));
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
// 12) MESSAGE LOG (kept from original, isolated from bot stability)
// ============================================================
client.on(Events.MessageCreate, async message => {
  try {
    if (!message.guild || message.author.bot) return;
    const room = await getRoom(message.channel.id);
    if (room) await sendBlogLog(message.guild, 'CHAT PHÒNG', `${message.author.tag}: ${(message.content || '[tệp]').slice(0, 500)}`);
    const gen = await getGenerator(message.guild.id);
    if (gen?.tracked_text_channel_id && message.channel.id === String(gen.tracked_text_channel_id))
      await sendBlogLog(message.guild, 'THEO DÕI CHAT', `${message.author.tag}: ${(message.content || '[tệp]').slice(0, 500)}`);
  } catch (e) { logError('MESSAGE_LOG', e); }
});

// ============================================================
// 13) INTERACTIONS
// ============================================================
async function requireRoomInteraction(interaction, ownerOnly = true) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error('USER_NOT_IN_VOICE');
  const room = await getRoom(channel.id);
  if (!room) throw new Error('NOT_TEMP_ROOM');
  if (ownerOnly && String(room.owner_id) !== interaction.user.id) throw new Error('NOT_OWNER');
  return { channel, room };
}
function friendlyError(err) {
  const msg = String(err?.message || err);
  if (msg === 'USER_NOT_IN_VOICE') return 'Bạn cần ở trong phòng thoại của mình.';
  if (msg === 'NOT_TEMP_ROOM') return 'Đây không phải phòng thoại tạm do bot quản lý.';
  if (msg === 'NOT_OWNER') return 'Chỉ chủ phòng mới dùng được chức năng này.';
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

    // ----- User selector actions -----
    if (interaction.isUserSelectMenu()) {
      const { channel, room } = await requireRoomInteraction(interaction, true);
      const target = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
      if (!target || target.user.bot) return safeReply(interaction, 'Thành viên không hợp lệ.', { error: true });
      if (target.id === interaction.user.id && interaction.customId !== 'vc_user_allow') return safeReply(interaction, 'Bạn không thể áp dụng thao tác này cho chính mình.', { error: true });
      await safeDeferUpdate(interaction);
      await ensureBotRoomPermissions(channel);

      if (interaction.customId === 'vc_user_allow') {
        await channel.permissionOverwrites.edit(target, { ViewChannel: true, Connect: true }, { reason: `TempVoice allow by ${interaction.user.tag}` });
        await sendBlogLog(interaction.guild, 'CHO PHÉP', `${interaction.user.tag} → ${target.user.tag}`);
        return safeReply(interaction, `Đã cho phép **${target.displayName}** vào phòng.`);
      }
      if (interaction.customId === 'vc_user_deny') {
        await channel.permissionOverwrites.edit(target, { ViewChannel: null, Connect: false }, { reason: `TempVoice deny by ${interaction.user.tag}` });
        if (target.voice.channelId === channel.id) await target.voice.disconnect('TempVoice: bị chủ phòng cấm');
        await sendBlogLog(interaction.guild, 'CẤM', `${interaction.user.tag} → ${target.user.tag}`);
        await refreshPanel(channel);
        return safeReply(interaction, `Đã cấm **${target.displayName}** khỏi phòng.`);
      }
      if (interaction.customId === 'vc_user_kick') {
        if (target.voice.channelId !== channel.id) return safeReply(interaction, 'Thành viên này không ở trong phòng của bạn.', { error: true });
        await target.voice.disconnect('TempVoice: chủ phòng mời rời');
        await sendBlogLog(interaction.guild, 'ĐUỔI', `${interaction.user.tag} → ${target.user.tag}`);
        await refreshPanel(channel);
        return safeReply(interaction, `Đã mời **${target.displayName}** rời phòng.`);
      }
      if (interaction.customId === 'vc_user_transfer') {
        if (target.voice.channelId !== channel.id) return safeReply(interaction, 'Người nhận phải đang ở trong phòng.', { error: true });
        await transferOwner(channel, target);
        await sendBlogLog(interaction.guild, 'CHUYỂN CHỦ', `${interaction.user.tag} → ${target.user.tag}`);
        await refreshPanel(channel);
        return safeReply(interaction, `Đã chuyển chủ phòng cho **${target.displayName}**.`);
      }
      return;
    }

    // ----- Buttons -----
    if (interaction.isButton()) {
      const { channel, room } = await requireRoomInteraction(interaction, false);
      const owner = String(room.owner_id) === interaction.user.id;

      if (interaction.customId === 'vc_claim') {
        const oldOwner = await interaction.guild.members.fetch(String(room.owner_id)).catch(() => null);
        if (oldOwner?.voice.channelId === channel.id) return safeReply(interaction, 'Chủ phòng vẫn đang ở đây.', { error: true });
        await safeDeferUpdate(interaction);
        await transferOwner(channel, interaction.member);
        await refreshPanel(channel, interaction.message);
        return safeReply(interaction, 'Bạn đã nhận quyền chủ phòng.');
      }
      if (!owner) {
        // Panel của owner được gửi trong voice text; non-owner chỉ được claim khi owner vắng.
        const oldOwner = await interaction.guild.members.fetch(String(room.owner_id)).catch(() => null);
        if (!oldOwner?.voice || oldOwner.voice.channelId !== channel.id) {
          return interaction.reply({ content: '👑 Chủ phòng đã rời. Bạn có thể **nhận phòng**:', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vc_claim').setLabel('Nhận phòng').setEmoji('👑').setStyle(ButtonStyle.Success))], ephemeral: true });
        }
        return safeReply(interaction, 'Chỉ chủ phòng mới dùng được chức năng này.', { error: true });
      }
      if (!checkCooldown(interaction.user.id, interaction.customId)) return safeReply(interaction, 'Thao tác quá nhanh.', { error: true, ttl: 1500 });

      if (['vc_lock','vc_unlock','vc_hide','vc_unhide','vc_reset'].includes(interaction.customId)) await safeDeferUpdate(interaction);
      if (interaction.customId === 'vc_lock') { await setRoomLocked(channel, true); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'KHÓA',interaction.user.tag); return safeReply(interaction,'Đã khóa phòng.'); }
      if (interaction.customId === 'vc_unlock') { await setRoomLocked(channel, false); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'MỞ',interaction.user.tag); return safeReply(interaction,'Đã mở phòng.'); }
      if (interaction.customId === 'vc_hide') { await setRoomHidden(channel, true); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'ẨN',interaction.user.tag); return safeReply(interaction,'Đã ẩn phòng.'); }
      if (interaction.customId === 'vc_unhide') { await setRoomHidden(channel, false); await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'HIỆN',interaction.user.tag); return safeReply(interaction,'Đã hiện phòng.'); }
      if (interaction.customId === 'vc_reset') {
        await setRoomLocked(channel, false); await setRoomHidden(channel, false); await channel.setUserLimit(0); await channel.setRTCRegion(null);
        // Xóa overwrite member ngoại trừ owner/bot; reset allow/deny phát sinh từ panel.
        for (const ow of channel.permissionOverwrites.cache.values()) {
          if (ow.id !== channel.guild.roles.everyone.id && ow.id !== channel.guild.members.me.id && ow.id !== String(room.owner_id)) await ow.delete('TempVoice reset').catch(() => {});
        }
        await setOwnerAccess(channel, String(room.owner_id), true);
        await refreshPanel(channel, interaction.message); await sendBlogLog(interaction.guild,'RESET',interaction.user.tag);
        return safeReply(interaction,'Đã đưa phòng về cấu hình mặc định.');
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
      const selectors = {
        vc_allow: ['vc_user_allow', 'Chọn người được phép vào', '✅'],
        vc_deny: ['vc_user_deny', 'Chọn người cần cấm', '⛔'],
        vc_kick: ['vc_user_kick', 'Chọn người cần mời ra', '👢'],
        vc_transfer: ['vc_user_transfer', 'Chọn chủ phòng mới', '👑']
      };
      if (selectors[interaction.customId]) {
        const [id, placeholder] = selectors[interaction.customId];
        const row = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1));
        return interaction.reply({ content: `**${placeholder}**`, components: [row], ephemeral: true });
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
  console.log(`[SHUTDOWN] ${signal}`);
  try { await client.destroy(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

client.login(TOKEN).catch(err => {
  logError('LOGIN', err);
  process.exit(1);
});
